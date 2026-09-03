/**
 * The verdict of `report --wait --fail-on=`.
 *
 * **Only one of the four outcomes is a pass, and the default for anything
 * ambiguous is to fail.** That is the opposite of every other decision this
 * client makes, and deliberately so: a gate is the one mode a user opted into
 * specifically to break a build, and a gate that cannot get an answer and
 * reports success is worse than no gate at all -- it is a green tick over an
 * unanswered question.
 */
export const PASSED = 'passed';
export const BREACHED = 'breached';
export const TIMED_OUT = 'timed_out';
export const ERRORED = 'errored';

export type GateStatus = typeof PASSED | typeof BREACHED | typeof TIMED_OUT | typeof ERRORED;

export class GateResult {
    private constructor(
        readonly status: GateStatus,
        readonly detail: string,
        readonly breaching: number = 0,
        /** Open Findings by severity, worst first. */
        readonly counts: Record<string, number> = {},
    ) {}

    static passed(counts: Record<string, number>): GateResult {
        return new GateResult(PASSED, 'ok', 0, counts);
    }

    static breached(breaching: number, threshold: string, counts: Record<string, number>): GateResult {
        return new GateResult(
            BREACHED,
            `${breaching} open finding${breaching === 1 ? '' : 's'} at ${threshold} or above`,
            breaching,
            counts,
        );
    }

    static timedOut(detail: string): GateResult {
        return new GateResult(TIMED_OUT, detail);
    }

    static errored(detail: string): GateResult {
        return new GateResult(ERRORED, detail);
    }

    isFailure(): boolean {
        return this.status !== PASSED;
    }

    /**
     * The per-severity line for a build log, or null when there is nothing to
     * report because we never got an answer.
     *
     * Every band is printed, zeros included. "0 critical" is a fact somebody
     * wanted confirmed; omitting it leaves the reader wondering whether the band
     * was checked or merely absent.
     */
    summary(): string | null {
        const entries = Object.entries(this.counts);

        if (entries.length === 0) {
            return null;
        }

        return entries.map(([severity, count]) => `${count} ${severity}`).join(', ');
    }

    /**
     * The process exit code.
     *
     * Two failing codes rather than one, and the distinction is the point: `1`
     * is "we looked and your build is over the line", `2` is "we could not find
     * out". A pipeline that wants to retry the second and never the first has no
     * other way to tell them apart.
     */
    exitCode(): number {
        if (this.status === PASSED) {
            return 0;
        }

        return this.status === BREACHED ? 1 : 2;
    }
}
