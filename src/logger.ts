import { EOL } from 'node:os';

/**
 * Minimal leveled logger writing to stderr.
 *
 * At the default level a normal install prints at most two lines. Nothing this
 * client does is important enough to clutter someone else's build output.
 *
 * stderr and never stdout: stdout may be parsed by whatever invoked the
 * install.
 */
export const LEVELS = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
} as const;

export type LevelName = keyof typeof LEVELS;

/** Where a Logger writes. `process.stderr` satisfies it; so does a test spy. */
export interface Sink {
    write(chunk: string): unknown;
}

export class Logger {
    private readonly level: number;

    private readonly sink: Sink;

    constructor(level = 'warn', sink: Sink = process.stderr) {
        this.level = LEVELS[level.toLowerCase() as LevelName] ?? LEVELS.warn;
        this.sink = sink;
    }

    error(message: string): void {
        this.write(LEVELS.error, message);
    }

    warn(message: string): void {
        this.write(LEVELS.warn, message);
    }

    info(message: string): void {
        this.write(LEVELS.info, message);
    }

    debug(message: string): void {
        this.write(LEVELS.debug, message);
    }

    /**
     * Printed regardless of level. Reserved for the one case where staying
     * quiet would be irresponsible: a credential committed to source control.
     */
    always(message: string): void {
        this.sink.write(`DepMan: ${message}${EOL}`);
    }

    private write(level: number, message: string): void {
        if (level > this.level) {
            return;
        }

        this.sink.write(`DepMan: ${message}${EOL}`);
    }
}
