import { decode } from './client.js';
import { Config } from './config.js';
import { GateResult } from './gate-result.js';
import type { Logger } from './logger.js';
import type { HttpResponse, Reporter } from './reporter.js';
import type { Result } from './result.js';
import type { Env } from './token.js';
import * as Token from './token.js';

/**
 * CI gating: wait for the report to be scanned, then decide whether to fail the
 * build.
 *
 * **This is the only mode permitted to fail a build, and it must never run from
 * a post-install hook.** It belongs in a dedicated CI step somebody added on
 * purpose -- see docs/ingest-clients.md section 10.
 *
 * Fail-closed throughout. A timeout, an unreadable response and a rejected poll
 * all exit non-zero, because the alternative is a security gate that answers
 * "probably fine" whenever our queue is slow. Everything else this client does
 * leans the other way; this is the exception the user asked for.
 *
 * **The two waits are overridable**, so the suite exercises the loop without
 * spending the wall-clock time the loop exists to spend.
 */

/**
 * The server's own severity ordering, mirrored.
 *
 * It has to match App\Enums\Severity::rank() or `--fail-on=high` means
 * something different on each side of the wire. `unknown` outranks `none` for
 * the reason the server gives: an advisory we could not band deserves a human's
 * attention more than one scored as genuinely harmless.
 *
 * **Exported so the server's suite can pin it**, the way DogfoodTest pins the
 * manifest digest. A client and a server that disagree about what "high" means
 * fail the same way the digest does -- silently, and only for the people
 * relying on it.
 */
export const RANKS: Record<string, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    unknown: 1,
    none: 0,
};

/** Thresholds a user may ask for. `none` is excluded: it would fail on nothing. */
export const THRESHOLDS = ['critical', 'high', 'medium', 'low', 'unknown'];

const FIRST_BACKOFF_SECONDS = 2;

const MAX_BACKOFF_SECONDS = 15;

export class Gate {
    constructor(
        private readonly logger: Logger,
        private readonly reporter: Reporter,
    ) {}

    /**
     * The CLI entry point: resolve what polling needs, then wait.
     *
     * The resolution lives here rather than in `cli.ts` on purpose. The CLI
     * shim is a thin wrapper around the library, and a security gate whose
     * decision logic sits in the least-tested file is a gate nobody has checked.
     */
    async run(
        projectRoot: string,
        result: Result,
        threshold: string | null,
        timeoutSeconds: number,
        env: Env = {},
    ): Promise<GateResult> {
        if (result.status !== 'reported') {
            // A gate that shrugs when the report never landed is a gate that
            // goes green for every build with a rotated token. The user asked
            // for a gate; not being able to run one is a failure of it.
            return GateResult.errored(
                `the report was not accepted (${result.detail}), so there is nothing to gate on.`,
            );
        }

        if (result.statusUrl === null) {
            return GateResult.errored('DepMan accepted the report but returned no status URL to poll.');
        }

        const config = Config.load(projectRoot, this.logger, env);

        if (config === null) {
            return GateResult.errored('depman.json disappeared between reporting and polling.');
        }

        const endpoint = config.endpoint(env);
        const found = Token.locate(endpoint, env, projectRoot);

        if (found === null) {
            return GateResult.errored('no token found, so the report cannot be polled.');
        }

        return this.await(endpoint, result.statusUrl, found.value, threshold, timeoutSeconds, config.timeoutMs(env));
    }

    /**
     * Poll until the report has been scanned, then judge it.
     *
     * `threshold` null means "wait and report, but do not gate" -- `--wait`
     * without `--fail-on=`, which is useful for seeing the numbers in a build
     * log without yet trusting them to stop a deploy.
     */
    async await(
        endpoint: string,
        statusUrl: string,
        token: string,
        threshold: string | null,
        timeoutSeconds: number,
        requestTimeoutMs: number,
    ): Promise<GateResult> {
        if (threshold !== null && !THRESHOLDS.includes(threshold)) {
            // Never "carry on without gating". A pipeline written against a
            // misspelled threshold would go green forever, which is the exact
            // failure this mode exists to prevent.
            return GateResult.errored(
                `unknown severity threshold "${threshold}". Use one of: ${THRESHOLDS.join(', ')}.`,
            );
        }

        if (!sameOrigin(endpoint, statusUrl)) {
            // The URL arrives in a response body, and the next thing we would do
            // is put a bearer token on it. A token belongs to one host, which is
            // the same reason section 7 forbids following redirects.
            return GateResult.errored(
                'the server returned a status URL on another host; refusing to send the token there.',
            );
        }

        const deadline = this.now() + timeoutSeconds;
        let backoff = FIRST_BACKOFF_SECONDS;

        for (;;) {
            const response = await this.reporter.fetch(statusUrl, token, requestTimeoutMs);
            const verdict = response === null ? null : this.judge(response, threshold);

            if (verdict !== null) {
                return verdict;
            }

            const detail =
                response === null
                    ? 'could not reach DepMan while waiting for the scan'
                    : 'the report was not scanned in time';

            const remaining = deadline - this.now();

            if (remaining <= 0) {
                return GateResult.timedOut(detail);
            }

            const wait = Math.min(backoff, remaining);
            this.logger.debug(`${detail}; polling again in ${wait}s.`);

            await this.pause(wait);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_SECONDS);
        }
    }

    /**
     * One poll: a verdict, or null meaning "not yet, keep waiting".
     */
    private judge(response: HttpResponse, threshold: string | null): GateResult | null {
        // 5xx and 429 are transient by definition; keep waiting rather than
        // failing the build over one bad poll.
        if (response.status >= 500 || response.status === 429) {
            return null;
        }

        if (response.status !== 200) {
            const error = decode(response.body).error;
            const code =
                error !== null &&
                typeof error === 'object' &&
                typeof (error as Record<string, unknown>).code === 'string'
                    ? String((error as Record<string, unknown>).code)
                    : '';

            return GateResult.errored(`the status endpoint refused the poll${code === '' ? '' : `: ${code}`}`);
        }

        let body: unknown;

        try {
            body = JSON.parse(response.body);
        } catch {
            return GateResult.errored('the status endpoint returned something that is not JSON.');
        }

        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return GateResult.errored('the status endpoint returned something that is not JSON.');
        }

        const fields = body as Record<string, unknown>;
        const reportStatus = typeof fields.status === 'string' ? fields.status : '';

        if (reportStatus === 'failed' || reportStatus === 'rejected') {
            // A gate cannot pass a tree that was never reconciled. This is the
            // distinction the server's failure handler exists to preserve: "no
            // vulnerabilities" and "we never processed your tree" must not look
            // the same.
            const why = typeof fields.error === 'string' ? fields.error : reportStatus;

            return GateResult.errored(`DepMan could not process the report: ${why}`);
        }

        const findings = fields.findings;

        // Null findings is the server saying "accepted, not scanned yet", and it
        // is a distinct state from an empty summary on purpose. Treating the two
        // alike would pass every build that polled once, quickly.
        if (findings === null || typeof findings !== 'object' || Array.isArray(findings)) {
            return null;
        }

        const counts = countsOf(findings as Record<string, unknown>);

        if (threshold === null) {
            return GateResult.passed(counts);
        }

        let breaching = 0;

        for (const [severity, count] of Object.entries(counts)) {
            const rank = RANKS[severity];
            const bar = RANKS[threshold];

            if (rank !== undefined && bar !== undefined && rank >= bar) {
                breaching += count;
            }
        }

        return breaching > 0 ? GateResult.breached(breaching, threshold, counts) : GateResult.passed(counts);
    }

    /**
     * Seams. Overridden in tests, so the suite exercises the loop without
     * spending the wall-clock time the loop exists to spend.
     */
    protected now(): number {
        return Math.floor(Date.now() / 1000);
    }

    protected pause(seconds: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, seconds * 1000);
        });
    }
}

/**
 * The per-severity buckets, worst first and with the totals dropped.
 *
 * Read key by key rather than taken wholesale: the summary also carries `total`
 * and `maxSeverity`, and a future band we do not rank would otherwise be
 * silently summed into a threshold comparison.
 */
function countsOf(findings: Record<string, unknown>): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const severity of Object.keys(RANKS)) {
        const value = findings[severity];

        counts[severity] = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
    }

    return counts;
}

/**
 * Whether the server's status URL points back at the endpoint we posted to.
 *
 * Scheme, host and port, and nothing else -- the path is the server's business.
 * A missing port compares equal to the scheme's default, because
 * `https://depman.io` and `https://depman.io:443` are the same origin and a
 * deployment behind a proxy may spell it either way.
 */
function sameOrigin(endpoint: string, statusUrl: string): boolean {
    const a = origin(endpoint);
    const b = origin(statusUrl);

    return a !== null && a === b;
}

function origin(url: string): string | null {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    const fallback = scheme === 'https' ? '443' : scheme === 'http' ? '80' : '';

    return `${scheme}://${parsed.hostname.toLowerCase()}:${parsed.port === '' ? fallback : parsed.port}`;
}
