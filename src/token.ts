import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as DotEnv from './dotenv.js';

/**
 * Finds the ingest token, which never lives in depman.json.
 *
 * Order, first hit wins:
 *
 *   1. `DEPMAN_TOKEN` in the project's `.env`
 *   2. `DEPMAN_TOKEN` in the process environment
 *   3. `DEPMAN_TOKEN_FILE`, from `.env` then the process environment
 *   4. `~/.depman/credentials`, keyed by endpoint host
 *
 * **`.env` comes first because of when this runs.** The hook fires during
 * `npm install`, and at that moment the consumer's application has not booted:
 * nothing has loaded `.env` into the process environment, so a developer who
 * put `DEPMAN_TOKEN` there -- the obvious place, and the place every other
 * secret in their project lives -- got "no token found, skipping" and no
 * explanation. Silence that looks like success is the one failure mode this
 * product cannot afford, and it was reachable through the most natural setup a
 * user could choose.
 *
 * The remaining order is unchanged: the process environment for CI, then a file
 * for Docker and Kubernetes secret mounts (which keeps the value out of `ps`
 * output and crash dumps), then a per-host credentials file.
 *
 * `Config` reads every other `DEPMAN_` setting the same way round, so there is
 * one answer to "where does the client look?" rather than one per setting.
 */
export interface FoundToken {
    /** Never logged. */
    readonly value: string;
    /** The mechanism that supplied it, which `doctor` prints. */
    readonly source: string;
}

export type Env = Record<string, string | undefined>;

export function find(endpoint: string, env: Env = {}, projectRoot: string | null = null): string | null {
    return locate(endpoint, env, projectRoot)?.value ?? null;
}

/**
 * The token and the mechanism that supplied it.
 */
export function locate(endpoint: string, env: Env = {}, projectRoot: string | null = null): FoundToken | null {
    if (projectRoot !== null) {
        const fromDotEnv = DotEnv.get(projectRoot, 'DEPMAN_TOKEN');

        if (fromDotEnv !== null) {
            return { value: fromDotEnv, source: '.env' };
        }
    }

    const direct = fromEnv('DEPMAN_TOKEN', env);

    if (direct !== null) {
        return { value: direct, source: 'DEPMAN_TOKEN' };
    }

    const file = tokenFilePath(env, projectRoot);

    if (file !== null) {
        const contents = read(file)?.trim();

        if (contents !== undefined && contents !== '') {
            return { value: contents, source: `DEPMAN_TOKEN_FILE (${file})` };
        }
    }

    const credentials = fromCredentialsFile(endpoint, env);

    return credentials === null ? null : { value: credentials, source: '~/.depman/credentials' };
}

/**
 * `DEPMAN_TOKEN_FILE` from `.env`, then from the process environment.
 *
 * Both sources, in the same order as the token itself and as every other
 * setting in `Config`, so the mechanisms do not disagree about where they look.
 */
function tokenFilePath(env: Env, projectRoot: string | null): string | null {
    const fromDotEnv = projectRoot === null ? null : DotEnv.get(projectRoot, 'DEPMAN_TOKEN_FILE');

    return fromDotEnv ?? fromEnv('DEPMAN_TOKEN_FILE', env);
}

function fromCredentialsFile(endpoint: string, env: Env): string | null {
    const home = fromEnv('DEPMAN_HOME', env) ?? fromEnv('HOME', env);

    if (home === null) {
        return null;
    }

    const contents = read(join(home, '.depman', 'credentials'));

    if (contents === null) {
        return null;
    }

    let decoded: unknown;

    try {
        decoded = JSON.parse(contents);
    } catch {
        return null;
    }

    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
        return null;
    }

    // Keyed by host so a developer can hold tokens for a self-hosted instance
    // and the SaaS at the same time.
    const host = hostOf(endpoint);

    if (host === null) {
        return null;
    }

    const token = (decoded as Record<string, unknown>)[host];

    return typeof token === 'string' && token !== '' ? token : null;
}

function hostOf(endpoint: string): string | null {
    try {
        return new URL(endpoint).hostname;
    } catch {
        return null;
    }
}

function read(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

/**
 * An explicit `env` map wins over the real process environment, so tests never
 * have to mutate global state to exercise a precedence rule.
 */
export function fromEnv(key: string, env: Env): string | null {
    if (Object.hasOwn(env, key)) {
        const value = env[key];

        return value === undefined || value === '' ? null : value;
    }

    const value = process.env[key];

    return value === undefined || value === '' ? null : value;
}
