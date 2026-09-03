import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, type Sink } from '../src/logger.js';
import { type HttpResponse, Reporter, type WirePayload } from '../src/reporter.js';

/**
 * Shared scaffolding for the suite.
 *
 * **Nothing here reads the host application's configuration.** A client that
 * can only be tested from inside the DepMan monorepo is not a client anybody
 * can release -- see docs/ingest-clients.md section 12. The one dependency on
 * a path outside `src/` is the wire fixture directory, and that is resolved
 * from this file rather than from a working directory.
 */

/** A Logger that records what it wrote, so assertions can be made on output. */
export class Recorder implements Sink {
    lines: string[] = [];

    write(chunk: string): boolean {
        this.lines.push(chunk.replace(/\r?\n$/, ''));

        return true;
    }

    text(): string {
        return this.lines.join('\n');
    }
}

export function recordingLogger(level = 'debug'): { logger: Logger; sink: Recorder } {
    const sink = new Recorder();

    return { logger: new Logger(level, sink), sink };
}

/** A throwaway project directory, removed by `cleanup()`. */
export function workspace(): string {
    return mkdtempSync(join(tmpdir(), 'depman-npm-client-'));
}

export function cleanup(directory: string): void {
    rmSync(directory, { recursive: true, force: true });
}

export function write(root: string, relative: string, contents: string): string {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);

    return path;
}

export function writeJson(root: string, relative: string, value: unknown): string {
    return write(root, relative, JSON.stringify(value, null, 2));
}

/**
 * A hidden lockfile with the given entries, keyed the way npm keys them.
 */
export function hiddenLockfile(root: string, packages: Record<string, unknown>): void {
    writeJson(root, 'node_modules/.package-lock.json', {
        name: 'consumer',
        lockfileVersion: 3,
        requires: true,
        packages,
    });
}

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'wire', 'v1');

/**
 * The canonical wire fixtures, resolved from the source tree rather than from
 * `dist/`, so the compiled tests read the same bytes the parity test compares.
 */
export function fixturePath(name: string): string {
    return join(FIXTURES, name);
}

/**
 * A Reporter whose transport is replaced.
 *
 * Every branch of the response handling is a status code, and reaching them for
 * real would mean a live server per case. Section 7 requires this seam of every
 * client, which is why `send()` and `fetch()` are overridable.
 */
export class FakeReporter extends Reporter {
    sent: WirePayload[] = [];

    fetched: string[] = [];

    constructor(
        private readonly responses: (HttpResponse | null)[] = [],
        private readonly polls: (HttpResponse | null)[] = [],
    ) {
        super(new Logger('silent', new Recorder()));
    }

    override async send(_endpoint: string, _token: string, payload: WirePayload): Promise<HttpResponse | null> {
        this.sent.push(structuredClone(payload));

        if (this.responses.length === 0) {
            throw new Error('FakeReporter was sent more payloads than it has responses for.');
        }

        return this.responses.shift() ?? null;
    }

    override async fetch(url: string): Promise<HttpResponse | null> {
        this.fetched.push(url);

        if (this.polls.length === 0) {
            throw new Error('FakeReporter was polled more times than it has responses for.');
        }

        return this.polls.shift() ?? null;
    }
}

/** A JSON HTTP response. */
export function json(status: number, body: unknown): HttpResponse {
    return { status, body: JSON.stringify(body) };
}
