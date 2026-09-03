import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from './client.js';
import { Logger } from './logger.js';
import { Reporter } from './reporter.js';
import { Resolver } from './resolver.js';

/**
 * The post-install entry point.
 *
 * A plain script rather than a lifecycle plugin: npm has no plugin mechanism a
 * consumer could consent to, and `scripts.postinstall` is the documented,
 * inspectable place for this.
 *
 * **The one hard rule of this module: it must never abort a consumer's
 * `npm install`.** Every path resolves, and every throwable is swallowed. A
 * dependency-inventory tool that breaks builds gets removed, and then it
 * protects nobody.
 */
export async function report(): Promise<void> {
    try {
        const root = projectRoot();
        const logger = new Logger(logLevel(root));

        const client = new Client(logger, new Resolver(logger), new Reporter(logger));
        const result = await client.report(root, 'postinstall');

        if (result.status === 'reported' && !result.deduplicated) {
            logger.always(`reported ${result.packages} packages.`);
        }
    } catch (exception) {
        // Intentionally swallowed. Failing here would break the install.
        if (process.env.DEPMAN_DEBUG !== undefined) {
            process.stderr.write(`DepMan: ${exception instanceof Error ? exception.message : String(exception)}\n`);
        }
    }
}

/**
 * npm sets INIT_CWD to the directory the command was invoked from, which is the
 * project root even when the script runs from inside node_modules.
 */
export function projectRoot(): string {
    const initCwd = process.env.INIT_CWD;

    if (initCwd !== undefined && initCwd !== '') {
        try {
            if (statSync(initCwd).isDirectory()) {
                return initCwd;
            }
        } catch {
            // Fall through to the working directory.
        }
    }

    return process.cwd();
}

/**
 * Read straight out of depman.json rather than through Config, because this
 * decides how loud Config itself is allowed to be while loading.
 */
function logLevel(projectRoot: string): string {
    const override = process.env.DEPMAN_LOG_LEVEL;

    if (override !== undefined && override !== '') {
        return override;
    }

    try {
        const decoded: unknown = JSON.parse(readFileSync(join(projectRoot, 'depman.json'), 'utf8'));

        if (decoded !== null && typeof decoded === 'object') {
            const level = (decoded as Record<string, unknown>).logLevel;

            if (typeof level === 'string') {
                return level;
            }
        }
    } catch {
        // No config, or an unreadable one. Config::load says so properly.
    }

    return 'warn';
}
