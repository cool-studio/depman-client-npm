import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as DotEnv from './dotenv.js';
import type { Logger } from './logger.js';
import type { Env } from './token.js';

/**
 * The depman.json contract, as loaded from a consumer project.
 *
 * Precedence for every setting is: **project `.env` > process env var >
 * depman.json > default.**
 *
 * `.env` comes first for the same reason it does for the token: the hook fires
 * during `npm install`, when the consumer's framework has not booted and
 * nothing has loaded `.env` into the process environment. A developer who put
 * `DEPMAN_ENDPOINT` or `DEPMAN_ENV` beside their token -- the only sensible
 * place -- would otherwise have it silently ignored, and the two mechanisms
 * would disagree about where they looked.
 *
 * depman.json is committed to source control, so it must never contain a
 * credential. A `token` key is refused loudly rather than silently honoured.
 */
const TOKEN_KEYS = ['token', 'apiToken', 'api_token', 'secret'] as const;

/**
 * Non-`DEPMAN_` variables this class may read out of a consumer's `.env`.
 *
 * `environment.from` names arbitrary variables and comes from depman.json,
 * which is committed and reviewed far less carefully than code. Without this
 * list, a one-line change to that array -- `["DB_PASSWORD"]` -- would read a
 * secret out of the densest secret store in the project and ship it to the
 * server as an environment name. A `DEPMAN_`-prefixed key is the consumer's own
 * namespace and needs no allowlist; anything else does.
 *
 * These are the variables that name an environment and nothing else. The list
 * is the specified one in docs/ingest-clients.md section 2, shared by every
 * client -- do not extend it here alone.
 */
const DOTENV_READABLE = [
    'APP_ENV',
    'NODE_ENV',
    'ENVIRONMENT',
    'CI_ENVIRONMENT_NAME',
    'RAILS_ENV',
    'SYMFONY_ENV',
] as const;

const DEFAULT_SOURCES = ['DEPMAN_ENV', 'APP_ENV', 'NODE_ENV', 'ENVIRONMENT', 'CI_ENVIRONMENT_NAME'];

const FALSEY = ['0', 'false', 'no', 'off'];

const TRUTHY = ['1', 'true', 'yes', 'on'];

export interface ResolvedEnvironment {
    readonly name: string;
    readonly resolvedFrom: string;
}

type Raw = Record<string, unknown>;

export class Config {
    /**
     * Memoised `.env` lookups, per key.
     *
     * `environment()` walks up to five source variables, and re-reading the
     * file once per source turns one hook into five file scans for no reason.
     * Caching the *result* rather than the parsed file keeps DotEnv's promise
     * that only the requested key ever leaves it.
     */
    private readonly dotEnvCache = new Map<string, string | null>();

    private constructor(
        readonly projectRoot: string,
        private readonly raw: Raw,
        private readonly logger: Logger,
    ) {}

    static load(projectRoot: string, logger: Logger, _env: Env = {}): Config | null {
        const path = join(projectRoot, 'depman.json');

        let present = false;

        try {
            present = statSync(path).isFile();
        } catch {
            present = false;
        }

        if (!present) {
            logger.debug('No depman.json found; nothing to report.');

            return null;
        }

        let decoded: unknown;

        try {
            decoded = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
            logger.error('depman.json is not valid JSON; skipping.');

            return null;
        }

        if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
            logger.error('depman.json is not valid JSON; skipping.');

            return null;
        }

        const config = new Config(projectRoot, decoded as Raw, logger);
        config.warnAboutCommittedSecrets();

        return config;
    }

    static fromObject(projectRoot: string, raw: Raw, logger: Logger): Config {
        return new Config(projectRoot, raw, logger);
    }

    private warnAboutCommittedSecrets(): void {
        for (const key of TOKEN_KEYS) {
            if (!Object.hasOwn(this.raw, key)) {
                continue;
            }

            // Deliberately printed regardless of log level. A token in a
            // committed file is already leaked; staying quiet helps nobody.
            this.logger.always(
                `a "${key}" key was found in depman.json, which is committed to source control. ` +
                    'It has been ignored. Rotate that token and use the DEPMAN_TOKEN environment variable.',
            );
        }
    }

    isEnabled(env: Env = {}): boolean {
        const override = this.fromEnv('DEPMAN_ENABLED', env);

        if (override !== null) {
            return !FALSEY.includes(override.toLowerCase());
        }

        return this.raw.enabled !== false;
    }

    endpoint(env: Env = {}): string {
        const configured = typeof this.raw.endpoint === 'string' ? this.raw.endpoint : null;
        const endpoint = this.fromEnv('DEPMAN_ENDPOINT', env) ?? configured ?? 'https://depman.io';

        return endpoint.replace(/\/+$/, '');
    }

    project(env: Env = {}): string | null {
        const configured = typeof this.raw.project === 'string' ? this.raw.project : null;
        const project = this.fromEnv('DEPMAN_PROJECT', env) ?? configured;

        return project !== null && project !== '' ? project : null;
    }

    /**
     * Resolve the environment at run time.
     *
     * The same commit runs in local, CI, staging and production, so a literal
     * would be wrong. The fallback is deliberately "local" and never
     * "production": mislabelling a laptop as production produces alerts nobody
     * asked for and hides the ones that matter.
     */
    environment(env: Env = {}): ResolvedEnvironment {
        const configured = this.section('environment');
        const sources = Array.isArray(configured.from) ? configured.from : DEFAULT_SOURCES;

        for (const variable of sources) {
            const name = String(variable);
            const value = this.fromEnv(name, env);

            if (value === null || value === '') {
                continue;
            }

            return { name: this.mapEnvironment(normalise(value)), resolvedFrom: name };
        }

        return { name: this.fallback(), resolvedFrom: 'fallback' };
    }

    private mapEnvironment(value: string): string {
        const configured = this.section('environment');
        const map = isRecord(configured.map) ? configured.map : {};
        const mappedRaw = map[value];
        const mapped = typeof mappedRaw === 'string' ? mappedRaw : value;

        const allowed = configured.allowed;

        if (Array.isArray(allowed) && !allowed.includes(mapped)) {
            // Coerce rather than invent an environment. Typos would otherwise
            // proliferate into environments nobody meant to create.
            const fallback = this.fallback();
            this.logger.warn(`environment "${mapped}" is not in the allowed list; using "${fallback}".`);

            return fallback;
        }

        return mapped;
    }

    private fallback(): string {
        const configured = this.section('environment').fallback;

        return normalise(typeof configured === 'string' ? configured : 'local');
    }

    includeDev(env: Env = {}): boolean {
        return this.includeFlag('dev', 'DEPMAN_INCLUDE_DEV', env);
    }

    /**
     * npm has optional dependencies and Composer does not, so this key is
     * documented in depman-json.md but unimplemented by the Composer client.
     * See the conformance table in docs/ingest-clients.md.
     */
    includeOptional(env: Env = {}): boolean {
        return this.includeFlag('optional', 'DEPMAN_INCLUDE_OPTIONAL', env);
    }

    private includeFlag(key: 'dev' | 'optional', variable: string, env: Env): boolean {
        const override = this.fromEnv(variable, env);

        if (override !== null) {
            return !FALSEY.includes(override.toLowerCase());
        }

        return this.section('include')[key] !== false;
    }

    failOnError(env: Env = {}): boolean {
        const override = this.fromEnv('DEPMAN_FAIL_ON_ERROR', env);

        if (override !== null) {
            return TRUTHY.includes(override.toLowerCase());
        }

        return this.raw.failOnError === true;
    }

    timeoutMs(env: Env = {}): number {
        const override = this.fromEnv('DEPMAN_TIMEOUT_MS', env);
        const configured = typeof this.raw.timeoutMs === 'number' ? this.raw.timeoutMs : 10000;
        const value = override !== null ? Number.parseInt(override, 10) : configured;

        // Clamped rather than honoured. An absurd configured value is a typo,
        // and a hook that holds an install open for ten minutes is worse than
        // one that gives up.
        return Math.max(1000, Math.min(Number.isFinite(value) ? value : 10000, 60000));
    }

    logLevel(env: Env = {}): string {
        const configured = typeof this.raw.logLevel === 'string' ? this.raw.logLevel : 'warn';

        return this.fromEnv('DEPMAN_LOG_LEVEL', env) ?? configured;
    }

    runsOnPostinstall(): boolean {
        return this.section('runOn').postinstall !== false;
    }

    manifestPath(): string {
        const configured = this.section('manifest').path;

        return typeof configured === 'string' ? configured : '.';
    }

    spoolDirectory(env: Env = {}): string {
        const configured = this.section('offline').spoolDir;
        const dir =
            this.fromEnv('DEPMAN_SPOOL_DIR', env) ?? (typeof configured === 'string' ? configured : '.depman/spool');

        return join(this.projectRoot, dir.replace(/^\/+/, ''));
    }

    offlineMode(env: Env = {}): 'spool' | 'skip' {
        const configured = this.section('offline').mode;
        const mode =
            this.fromEnv('DEPMAN_OFFLINE_MODE', env) ?? (typeof configured === 'string' ? configured : 'spool');

        return mode === 'skip' ? 'skip' : 'spool';
    }

    /**
     * Where a setting's value came from, for `doctor`.
     *
     * Worth printing now that `.env` shadows the process environment for every
     * setting and not just the token: "the endpoint is wrong and I have
     * exported the right one" has three possible answers, and without this line
     * the first support ticket is unanswerable. `resolvedFrom` already does the
     * same job for the environment and a FoundToken's `source` for the token.
     */
    sourceOf(key: string, envKey: string, env: Env = {}): string {
        if (this.fromDotEnv(envKey) !== null) {
            return '.env';
        }

        const explicit = Object.hasOwn(env, envKey) ? env[envKey] : process.env[envKey];

        if (explicit !== undefined && explicit !== '') {
            return envKey;
        }

        return Object.hasOwn(this.raw, key) ? 'depman.json' : 'the default';
    }

    /**
     * One setting, from `.env` first and then the process environment.
     */
    private fromEnv(key: string, env: Env): string | null {
        const fromDotEnv = this.fromDotEnv(key);

        if (fromDotEnv !== null) {
            return fromDotEnv;
        }

        if (Object.hasOwn(env, key)) {
            const value = env[key];

            return value === undefined || value === '' ? null : value;
        }

        const value = process.env[key];

        return value === undefined || value === '' ? null : value;
    }

    /**
     * The project's `.env`, for keys this class is allowed to read.
     */
    private fromDotEnv(key: string): string | null {
        if (!key.startsWith('DEPMAN_') && !DOTENV_READABLE.includes(key as (typeof DOTENV_READABLE)[number])) {
            return null;
        }

        if (!this.dotEnvCache.has(key)) {
            this.dotEnvCache.set(key, DotEnv.get(this.projectRoot, key));
        }

        return this.dotEnvCache.get(key) ?? null;
    }

    private section(key: string): Record<string, unknown> {
        const value = this.raw[key];

        return isRecord(value) ? value : {};
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalise(value: string): string {
    return value.trim().toLowerCase();
}
