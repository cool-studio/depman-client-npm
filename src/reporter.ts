import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Config, ResolvedEnvironment } from './config.js';
import type { Logger } from './logger.js';
import type { PackageEntry } from './resolver.js';

/**
 * Builds the wire payload and delivers it.
 *
 * Zero runtime dependencies by design -- this package installs into everyone
 * else's dependency tree, so it uses node's own http client and nothing else.
 *
 * **`send()` and `fetch()` are overridable**, which is what makes the
 * orchestrator testable. Every branch in Client's response handling is a
 * response status, and reaching them for real would mean a live server per
 * case. The client specification requires this seam of every client; see
 * docs/ingest-clients.md section 7.
 */
export interface HttpResponse {
    readonly status: number;
    readonly body: string;
}

export interface WirePayload {
    depmanWireVersion: number;
    report: { manifestDigest: string; generatedAt: string; reason: string };
    project: string | null;
    environment: { name: string; resolvedFrom: string; ci: boolean };
    client: {
        name: string;
        version: string;
        packageManager: { name: string; version: string };
        runtime: { name: string; version: string };
    };
    ecosystem: string;
    manifest: { path: string; lockfileName: string };
    packages: PackageEntry[];
    counts: { packages: number };
    warnings: unknown[];
}

export const WIRE_VERSION = 1;

export const CLIENT_NAME = '@depman/client';

/**
 * The client's own release version, sent in the payload and the User-Agent.
 *
 * **Bump this in the commit that gets tagged**, not afterwards: it is the only
 * thing that tells support which build produced a report, and a constant that
 * lags the tag makes every report lie about itself. See the client release
 * checklist in docs/release-checklist.md.
 */
export const CLIENT_VERSION = '0.1.1';

export class Reporter {
    constructor(private readonly logger: Logger) {}

    buildPayload(
        config: Config,
        packages: PackageEntry[],
        environment: ResolvedEnvironment,
        reason: string,
    ): WirePayload {
        return {
            depmanWireVersion: WIRE_VERSION,
            report: {
                manifestDigest: this.digest(packages, environment.name),
                generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                reason,
            },
            project: config.project(),
            environment: {
                name: environment.name,
                resolvedFrom: environment.resolvedFrom,
                ci: looksLikeCi(),
            },
            client: {
                name: CLIENT_NAME,
                version: CLIENT_VERSION,
                packageManager: { name: 'npm', version: npmVersion() },
                runtime: { name: 'node', version: process.version.replace(/^v/, '') },
            },
            ecosystem: 'npm',
            manifest: {
                path: config.manifestPath(),
                lockfileName: 'package-lock.json',
            },
            packages,
            counts: { packages: packages.length },
            warnings: [],
        };
    }

    /**
     * Must match the server's computation exactly, or every report reports a
     * digest mismatch. Semantic content only -- no timestamps, no client
     * version.
     *
     * The caller must have deduplicated on purl first: the server digests its
     * own deduplicated entries, so a payload carrying the same purl twice
     * digests differently on each side. Resolver does this.
     */
    digest(packages: readonly PackageEntry[], environmentName: string): string {
        const lines = packages.map((entry) => [entry.purl, entry.scope, entry.relationship].join('\t'));

        // Byte-wise, never a locale or natural sort.
        lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        const payload = `depman-manifest-v1\nnpm\n${environmentName}\n${lines.join('\n')}`;

        return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
    }

    /**
     * Null on a transport failure.
     */
    async send(endpoint: string, token: string, payload: WirePayload, timeoutMs: number): Promise<HttpResponse | null> {
        return this.request(
            'POST',
            `${endpoint}/api/v1/reports`,
            {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Depman-Wire-Version': String(WIRE_VERSION),
                'User-Agent': `${CLIENT_NAME}/${CLIENT_VERSION}`,
            },
            JSON.stringify(payload),
            timeoutMs,
        );
    }

    /**
     * A GET against a URL the server itself handed us, for `report --wait`.
     *
     * Overridable for the same reason `send()` is: polling is the other half of
     * CI gating, and every branch of it is a response the client cannot produce
     * without a live server and a queue.
     *
     * **The caller must have checked the origin before calling this.** The URL
     * arrives in a response body and the next thing that happens to it is a
     * bearer token -- see Gate's origin check.
     */
    async fetch(url: string, token: string, timeoutMs: number): Promise<HttpResponse | null> {
        return this.request(
            'GET',
            url,
            {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'Depman-Wire-Version': String(WIRE_VERSION),
                'User-Agent': `${CLIENT_NAME}/${CLIENT_VERSION}`,
            },
            null,
            timeoutMs,
        );
    }

    private request(
        method: string,
        url: string,
        headers: Record<string, string>,
        body: string | null,
        timeoutMs: number,
    ): Promise<HttpResponse | null> {
        let target: URL;

        try {
            target = new URL(url);
        } catch {
            this.logger.debug(`transport failure: [${url}] is not a URL.`);

            return Promise.resolve(null);
        }

        const send = target.protocol === 'http:' ? httpRequest : httpsRequest;

        return new Promise((resolve) => {
            let settled = false;

            const finish = (value: HttpResponse | null): void => {
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            };

            const outgoing = send(
                target,
                {
                    method,
                    headers: body === null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
                    timeout: timeoutMs,
                },
                (response) => {
                    const chunks: Buffer[] = [];

                    response.on('data', (chunk: Buffer) => chunks.push(chunk));
                    response.on('end', () =>
                        finish({
                            status: response.statusCode ?? 0,
                            body: Buffer.concat(chunks).toString('utf8'),
                        }),
                    );
                    response.on('error', (error: Error) => {
                        this.logger.debug(`transport failure: ${error.message}`);
                        finish(null);
                    });
                },
            );

            // A redirect is never followed -- node does not follow one on its
            // own, and nothing here adds it. Following would replay the bearer
            // token at whatever host answered.
            outgoing.on('error', (error: Error) => {
                this.logger.debug(`transport failure: ${error.message}`);
                finish(null);
            });

            outgoing.on('timeout', () => {
                this.logger.debug(`transport failure: timed out after ${timeoutMs}ms.`);
                outgoing.destroy();
                finish(null);
            });

            if (body !== null) {
                outgoing.write(body);
            }

            outgoing.end();
        });
    }
}

function looksLikeCi(): boolean {
    for (const variable of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI']) {
        const value = process.env[variable];

        if (value !== undefined && value !== '' && value.toLowerCase() !== 'false') {
            return true;
        }
    }

    return false;
}

/**
 * npm sets `npm_config_user_agent` for anything it runs, in the shape
 * `npm/10.9.0 node/v22.11.0 linux x64 workspaces/false`.
 */
function npmVersion(): string {
    const agent = process.env.npm_config_user_agent;
    const matched = agent === undefined ? null : /(?:^|\s)npm\/(\S+)/.exec(agent);

    return matched?.[1] ?? 'unknown';
}
