/**
 * The outcome of a report attempt.
 *
 * Note that `skipped` and `spooled` are not failures: no token, no depman.json
 * and an unreachable server are all ordinary situations that must not fail a
 * consumer's build.
 */
export type ResultStatus = 'reported' | 'skipped' | 'spooled' | 'failed';

export class Result {
    private constructor(
        readonly status: ResultStatus,
        readonly detail: string,
        readonly packages: number = 0,
        readonly deduplicated: boolean = false,
        readonly statusUrl: string | null = null,
    ) {}

    /**
     * `statusUrl` is the server's own link to this report's status, and it is
     * carried here because it is the only input CI gating has: `--wait` polls
     * it rather than reconstructing a URL from the endpoint and an id it would
     * have to learn to parse. Null when the server did not send one -- an
     * unsupported ecosystem creates no Report to poll.
     */
    static reported(packages: number, deduplicated: boolean, statusUrl: string | null = null): Result {
        return new Result('reported', 'ok', packages, deduplicated, statusUrl);
    }

    static skipped(detail: string): Result {
        return new Result('skipped', detail);
    }

    static spooled(detail: string): Result {
        return new Result('spooled', detail);
    }

    static failed(detail: string): Result {
        return new Result('failed', detail);
    }

    isFailure(): boolean {
        return this.status === 'failed';
    }
}
