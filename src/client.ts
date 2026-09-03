import { Config } from './config.js';
import type { Logger } from './logger.js';
import type { HttpResponse, Reporter, WirePayload } from './reporter.js';
import type { Resolver } from './resolver.js';
import { Result } from './result.js';
import { Spool } from './spool.js';
import type { Env } from './token.js';
import * as Token from './token.js';

/**
 * Orchestrates a single report.
 *
 * Returns a result rather than throwing or exiting, so the caller decides what
 * failure means. From a post-install hook, failure means nothing at all.
 */
export class Client {
    constructor(
        private readonly logger: Logger,
        private readonly resolver: Resolver,
        private readonly reporter: Reporter,
    ) {}

    async report(projectRoot: string, reason = 'manual', env: Env = {}): Promise<Result> {
        const config = Config.load(projectRoot, this.logger, env);

        if (config === null) {
            return Result.skipped('no depman.json');
        }

        if (!config.isEnabled(env)) {
            this.logger.debug('disabled by configuration.');

            return Result.skipped('disabled');
        }

        if (reason === 'postinstall' && !config.runsOnPostinstall()) {
            return Result.skipped('post-install reporting is disabled');
        }

        const project = config.project(env);

        if (project === null) {
            this.logger.warn('depman.json has no "project"; skipping.');

            return Result.skipped('no project configured');
        }

        const endpoint = config.endpoint(env);
        const found = Token.locate(endpoint, env, projectRoot);

        if (found === null) {
            // The normal state for an open-source contributor who just cloned
            // the repository. It must be harmless and near-silent.
            this.logger.info('no token found, skipping. Set DEPMAN_TOKEN in .env or the environment to report.');

            return Result.skipped('no token');
        }

        // The source, never the value.
        this.logger.debug(`token found via ${found.source}.`);

        const packages = this.resolver.resolve(projectRoot, config.includeDev(env), config.includeOptional(env));

        if (packages === null) {
            return Result.skipped('no installed tree');
        }

        const environment = config.environment(env);
        const payload = this.reporter.buildPayload(config, packages, environment, reason);

        const response = await this.reporter.send(endpoint, found.value, payload, config.timeoutMs(env));

        if (response === null) {
            return this.handleUndelivered(config, payload, env, 'could not reach DepMan');
        }

        return this.interpret(config, payload, response, environment.name, packages.length, env);
    }

    private interpret(
        config: Config,
        payload: WirePayload,
        response: HttpResponse,
        environment: string,
        count: number,
        env: Env,
    ): Result {
        const status = response.status;
        const decoded = decode(response.body);

        if (status === 200 || status === 202) {
            const deduplicated = decoded.deduplicated === true;

            this.logger.info(
                `reported ${count} packages (${environment})${deduplicated ? ' — unchanged since the last report' : ''}`,
            );

            const warnings = Array.isArray(decoded.warnings) ? decoded.warnings : [];

            for (const warning of warnings) {
                if (warning !== null && typeof warning === 'object' && 'code' in warning) {
                    const entry = warning as Record<string, unknown>;
                    this.logger.warn(
                        `${String(entry.code)}: ${entry.detail === undefined ? '' : String(entry.detail)}`,
                    );
                }
            }

            const statusUrl = decoded.statusUrl;

            return Result.reported(
                count,
                deduplicated,
                typeof statusUrl === 'string' && statusUrl !== '' ? statusUrl : null,
            );
        }

        // A rate limit is not a failure. A developer adding packages one at a
        // time will hit it, and that must never look like something broke.
        if (status === 429) {
            this.logger.debug('rate limited; spooling for later.');

            return this.handleUndelivered(config, payload, env, 'rate limited');
        }

        if (status >= 500) {
            return this.handleUndelivered(config, payload, env, 'DepMan is unavailable');
        }

        const error = isRecord(decoded.error) ? decoded.error : {};
        const code = typeof error.code === 'string' ? error.code : `http_${status}`;
        const message = typeof error.message === 'string' ? error.message : 'The report was rejected.';

        // 4xx is a configuration problem the user needs to see and fix; there
        // is no point spooling something that will be rejected again.
        this.logger.error(`${code}: ${message}`);

        return Result.failed(`${code}: ${message}`);
    }

    private handleUndelivered(config: Config, payload: WirePayload, env: Env, reason: string): Result {
        if (config.offlineMode(env) === 'skip') {
            return Result.skipped(reason);
        }

        const spooled = new Spool(config.spoolDirectory(env), this.logger).write(payload);

        this.logger.debug(`${reason}${spooled ? '; spooled for later.' : '; dropped.'}`);

        return Result.spooled(reason);
    }
}

export function decode(body: string): Record<string, unknown> {
    try {
        const decoded: unknown = JSON.parse(body);

        return isRecord(decoded) ? decoded : {};
    } catch {
        return {};
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
