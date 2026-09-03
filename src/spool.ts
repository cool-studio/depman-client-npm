import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from './logger.js';
import type { WirePayload } from './reporter.js';

/**
 * Holds payloads that could not be delivered, for a later `depman push`.
 *
 * An air-gapped build or a flaky runner should not lose its inventory. The
 * directory is capped so a permanently offline project cannot fill a disk.
 *
 * The token is never written here. A spool file is a dependency inventory and
 * nothing else -- it is on disk, unencrypted, in somebody's working tree.
 */
const MAX_FILES = 20;

export class Spool {
    constructor(
        private readonly directory: string,
        private readonly logger: Logger,
    ) {}

    write(payload: WirePayload): boolean {
        try {
            mkdirSync(this.directory, { recursive: true, mode: 0o775 });
        } catch {
            this.logger.debug('Could not create the spool directory; dropping this report.');

            return false;
        }

        const file = join(this.directory, `${stamp()}-${randomBytes(4).toString('hex')}.json`);

        try {
            writeFileSync(file, JSON.stringify(payload));
        } catch {
            return false;
        }

        this.prune();
        this.warnIfTracked();

        return true;
    }

    /** Sorted, and the filenames sort chronologically. */
    pending(): string[] {
        try {
            return readdirSync(this.directory)
                .filter((name) => name.endsWith('.json'))
                .sort()
                .map((name) => join(this.directory, name));
        } catch {
            return [];
        }
    }

    /**
     * One spooled payload, or null when the file cannot be read as one.
     *
     * A truncated write -- the disk filled, or the build was killed mid-install
     * -- leaves a file that will never decode. The caller discards those rather
     * than retrying them forever: at a 20-file cap, a payload that can never
     * leave is a slot that evicts good ones.
     */
    read(file: string): WirePayload | null {
        let decoded: unknown;

        try {
            decoded = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
            return null;
        }

        return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
            ? (decoded as WirePayload)
            : null;
    }

    forget(file: string): void {
        try {
            unlinkSync(file);
        } catch {
            // A file that is already gone needs no forgetting.
        }
    }

    private prune(): void {
        const files = this.pending();

        // Oldest first: a stale inventory is less useful than a recent one.
        for (const stale of files.slice(0, Math.max(0, files.length - MAX_FILES))) {
            this.forget(stale);
        }
    }

    private warnIfTracked(): void {
        // The spool default is `<root>/.depman/spool`, so the project root is
        // two levels up from the directory itself.
        const gitignore = join(dirname(dirname(this.directory)), '.gitignore');

        try {
            if (!statSync(gitignore).isFile()) {
                return;
            }
        } catch {
            return;
        }

        if (!readFileSync(gitignore, 'utf8').includes('.depman')) {
            this.logger.warn(
                'the spool directory is not in .gitignore; add ".depman/" to avoid committing inventory files.',
            );
        }
    }
}

/**
 * `20260903-142530-889`, which sorts chronologically as a filename.
 *
 * Millisecond precision, not second: section 9 requires the drain to run oldest
 * first, and a CI run that spools several payloads inside one second would
 * otherwise order them by the random suffix that follows -- which is to say, not
 * at all.
 */
function stamp(): string {
    const now = new Date();
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

    return (
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
        `-${pad(now.getMilliseconds(), 3)}`
    );
}
