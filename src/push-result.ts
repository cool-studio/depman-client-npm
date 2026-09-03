/**
 * The outcome of draining the spool.
 *
 * Counts rather than a single status, because a drain is not one thing: some
 * payloads land, one can be rejected outright, and the run can stop partway
 * because the server is still unreachable. Collapsing that into "ok" or "not
 * ok" throws away the number the operator actually wants, which is how much
 * inventory is still sitting on disk.
 */
export type PushStatus = 'skipped' | 'drained' | 'stopped';

export class PushResult {
    private constructor(
        readonly status: PushStatus,
        /** Payloads the server accepted and that have been deleted. */
        readonly sent: number,
        /** Payloads dropped unsent because they can never succeed. */
        readonly discarded: number,
        /** Payloads still on disk, to be retried by a later push. */
        readonly remaining: number,
        /** Why the drain stopped, or 'ok' when it ran to the end. */
        readonly detail: string,
        /** Whether the user has something to fix. */
        readonly failed: boolean,
    ) {}

    static skipped(detail: string): PushResult {
        return new PushResult('skipped', 0, 0, 0, detail, false);
    }

    /**
     * The drain reached the end of the queue.
     *
     * Still a failure when anything was discarded: a rejected payload is a
     * configuration problem, and it is the one outcome here that a person has
     * to act on.
     */
    static drained(sent: number, discarded: number): PushResult {
        return new PushResult('drained', sent, discarded, 0, 'ok', discarded > 0);
    }

    /**
     * The drain stopped early, leaving the rest for next time.
     *
     * `failed` is the caller's judgement, not this class's: an unreachable
     * server is exactly what the spool is for and must not be an error, while a
     * rejected token is a thing somebody has to fix.
     */
    static stopped(sent: number, discarded: number, remaining: number, detail: string, failed: boolean): PushResult {
        return new PushResult('stopped', sent, discarded, remaining, detail, failed);
    }

    isFailure(): boolean {
        return this.failed;
    }
}
