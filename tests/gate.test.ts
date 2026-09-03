import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { Gate, RANKS, THRESHOLDS } from '../src/gate.js';
import { BREACHED, ERRORED, PASSED, TIMED_OUT } from '../src/gate-result.js';
import type { HttpResponse } from '../src/reporter.js';
import { Result } from '../src/result.js';
import { cleanup, FakeReporter, json, recordingLogger, workspace, writeJson } from './helpers.js';

const roots: string[] = [];

const ENDPOINT = 'https://depman.example';
const STATUS_URL = 'https://depman.example/api/v1/reports/01ABC';

/**
 * A Gate whose clock and sleep are replaced, so the suite exercises the polling
 * loop without spending the wall-clock time the loop exists to spend.
 */
class TestGate extends Gate {
    slept: number[] = [];

    private clock = 1_000_000;

    protected override now(): number {
        return this.clock;
    }

    protected override async pause(seconds: number): Promise<void> {
        this.slept.push(seconds);
        this.clock += seconds;
    }
}

function gate(polls: (HttpResponse | null)[]): { gate: TestGate; reporter: FakeReporter } {
    const { logger } = recordingLogger('silent');
    const reporter = new FakeReporter([], polls);

    return { gate: new TestGate(logger, reporter), reporter };
}

/** A scanned status body with the given per-severity counts. */
function scanned(counts: Partial<Record<string, number>> = {}): HttpResponse {
    return json(200, {
        status: 'processed',
        scanned: true,
        findings: {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
            unknown: 0,
            none: 0,
            total: 0,
            maxSeverity: null,
            ...counts,
        },
    });
}

/** Accepted, but no scan covering it has run yet. */
const NOT_YET = json(200, { status: 'processed', scanned: false, findings: null });

function project(): string {
    const root = workspace();
    roots.push(root);
    writeJson(root, 'depman.json', { project: 'storefront', endpoint: ENDPOINT });

    return root;
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('Severity ordering', () => {
    test('it mirrors the server’s own ranking, with unknown above none', () => {
        // A client and a server that disagree about what "high" means fail
        // silently, and only for the people relying on it.
        assert.deepEqual(RANKS, { critical: 5, high: 4, medium: 3, low: 2, unknown: 1, none: 0 });
    });

    test('none is not a threshold a user may ask for, because it would fail on nothing', () => {
        assert.deepEqual(THRESHOLDS, ['critical', 'high', 'medium', 'low', 'unknown']);
        assert.equal(THRESHOLDS.includes('none'), false);
    });

    for (const [threshold, band, breaches] of [
        ['high', 'critical', true],
        ['high', 'high', true],
        ['high', 'medium', false],
        ['critical', 'high', false],
        ['low', 'unknown', false],
        ['unknown', 'unknown', true],
        ['low', 'low', true],
    ] as const) {
        test(`--fail-on=${threshold} ${breaches ? 'catches' : 'ignores'} a ${band} finding`, async () => {
            const { gate: g } = gate([scanned({ [band]: 1 })]);
            const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', threshold, 300, 1000);

            assert.equal(verdict.status, breaches ? BREACHED : PASSED);
            assert.equal(verdict.exitCode(), breaches ? 1 : 0);
        });
    }

    test('--fail-on=low does not catch an advisory nobody could band', async () => {
        // unknown outranks none but sits below low; --fail-on=unknown is how a
        // team asks for those too.
        const { gate: g } = gate([scanned({ unknown: 3 })]);

        assert.equal((await g.await(ENDPOINT, STATUS_URL, 'tok', 'low', 300, 1000)).status, PASSED);
    });
});

describe('Fail-closed', () => {
    test('an unrecognised threshold is an error, never a warning', async () => {
        // A pipeline written against a misspelling would go green forever,
        // which is precisely the failure this mode exists to prevent.
        const { gate: g, reporter } = gate([]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', 'hihg', 300, 1000);

        assert.equal(verdict.status, ERRORED);
        assert.equal(verdict.exitCode(), 2);
        assert.deepEqual(reporter.fetched, [], 'it should not even poll');
    });

    test('a status URL on another host never receives the token', async () => {
        const { gate: g, reporter } = gate([]);
        const verdict = await g.await(ENDPOINT, 'https://evil.example/api/v1/reports/1', 'tok', 'high', 300, 1000);

        assert.equal(verdict.status, ERRORED);
        assert.match(verdict.detail, /another host/);
        assert.deepEqual(reporter.fetched, []);
    });

    test('an explicit default port is the same origin', async () => {
        const { gate: g } = gate([scanned()]);
        const verdict = await g.await(
            'https://depman.example',
            'https://depman.example:443/api/v1/reports/1',
            'tok',
            'high',
            300,
            1000,
        );

        assert.equal(verdict.status, PASSED);
    });

    test('a different port is a different origin', async () => {
        const { gate: g } = gate([]);
        const verdict = await g.await(ENDPOINT, 'https://depman.example:8443/x', 'tok', 'high', 300, 1000);

        assert.equal(verdict.status, ERRORED);
    });

    test('running out of time is not a pass', async () => {
        const { gate: g } = gate([NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 10, 1000);

        assert.equal(verdict.status, TIMED_OUT);
        assert.equal(verdict.exitCode(), 2);
    });

    test('an unprocessable report is not a pass', async () => {
        // "No vulnerabilities" and "we never processed your tree" must not look
        // the same.
        const { gate: g } = gate([json(200, { status: 'failed', error: 'reconciliation blew up', findings: null })]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 300, 1000);

        assert.equal(verdict.status, ERRORED);
        assert.match(verdict.detail, /reconciliation blew up/);
    });

    test('a refused poll names the code', async () => {
        const { gate: g } = gate([json(403, { error: { code: 'token_revoked' } })]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 300, 1000);

        assert.equal(verdict.status, ERRORED);
        assert.match(verdict.detail, /token_revoked/);
    });

    test('a non-JSON body is an error, not a pass', async () => {
        const { gate: g } = gate([{ status: 200, body: '<html>gateway</html>' }]);

        assert.equal((await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 300, 1000)).status, ERRORED);
    });

    test('a report that was never accepted cannot be gated on', async () => {
        // A rotated token would otherwise silently disable the security gate on
        // every build thereafter.
        const { gate: g } = gate([]);
        const verdict = await g.run(project(), Result.skipped('no token'), 'high', 300);

        assert.equal(verdict.status, ERRORED);
        assert.equal(verdict.exitCode(), 2);
        assert.match(verdict.detail, /not accepted/);
    });

    test('a reported result with no status URL cannot be gated on', async () => {
        const { gate: g } = gate([]);
        const verdict = await g.run(project(), Result.reported(1, false, null), 'high', 300);

        assert.equal(verdict.status, ERRORED);
        assert.match(verdict.detail, /no status URL/);
    });

    test('no token means the report cannot be polled', async () => {
        const { gate: g } = gate([]);
        const verdict = await g.run(project(), Result.reported(1, false, STATUS_URL), 'high', 300, {
            DEPMAN_HOME: workspace(),
        });

        assert.equal(verdict.status, ERRORED);
        assert.match(verdict.detail, /no token/);
    });
});

describe('Waiting for the scan', () => {
    test('it waits for scanned findings, not for a processed status', async () => {
        // The server marks a report processed when reconciliation ends and only
        // then queues the scan, so a client that stops at processed reads the
        // previous report's findings.
        const { gate: g, reporter } = gate([NOT_YET, NOT_YET, scanned({ high: 1 })]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 300, 1000);

        assert.equal(verdict.status, BREACHED);
        assert.equal(reporter.fetched.length, 3);
    });

    test('null findings is never treated as an empty summary', async () => {
        // Two polls, not one: the loop only gives up once the deadline has
        // actually passed, so a one-second budget buys a poll, a one-second
        // sleep, and a final poll.
        const { gate: g } = gate([NOT_YET, NOT_YET]);

        assert.equal((await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 1, 1000)).status, TIMED_OUT);
    });

    test('a transient 5xx or 429 is not a verdict', async () => {
        const { gate: g } = gate([json(503, {}), json(429, {}), scanned()]);

        assert.equal((await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 300, 1000)).status, PASSED);
    });

    test('a transport failure while waiting is not a verdict', async () => {
        const { gate: g } = gate([null, scanned()]);

        assert.equal((await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 300, 1000)).status, PASSED);
    });

    test('the backoff widens and is capped', async () => {
        const { gate: g } = gate([NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET, NOT_YET, scanned()]);
        await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 3600, 1000);

        assert.deepEqual(g.slept, [2, 4, 8, 15, 15, 15, 15]);
    });

    test('it never sleeps past the deadline', async () => {
        const { gate: g } = gate([NOT_YET, NOT_YET, NOT_YET]);
        await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 5, 1000);

        assert.equal(
            g.slept.reduce((total, seconds) => total + seconds, 0) <= 5,
            true,
            `slept ${JSON.stringify(g.slept)} against a 5s budget`,
        );
    });

    test('it polls the URL the server returned, not one it rebuilt', async () => {
        const { gate: g, reporter } = gate([scanned()]);
        await g.await(ENDPOINT, STATUS_URL, 'tok', null, 300, 1000);

        assert.deepEqual(reporter.fetched, [STATUS_URL]);
    });
});

describe('Reporting the numbers', () => {
    test('--wait without a threshold reports but does not gate', async () => {
        const { gate: g } = gate([scanned({ critical: 9 })]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', null, 300, 1000);

        assert.equal(verdict.status, PASSED);
        assert.equal(verdict.exitCode(), 0);
        assert.match(verdict.summary() ?? '', /9 critical/);
    });

    test('every band is printed, zeros included', async () => {
        const { gate: g } = gate([scanned({ high: 2 })]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', null, 300, 1000);

        assert.equal(verdict.summary(), '0 critical, 2 high, 0 medium, 0 low, 0 unknown, 0 none');
    });

    test('total and maxSeverity are never summed into the comparison', async () => {
        // The summary carries them alongside the bands, and a future band we do
        // not rank must not be silently counted either.
        const { gate: g } = gate([scanned({ total: 40, invented: 7 } as Record<string, number>)]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', 'unknown', 300, 1000);

        assert.equal(verdict.status, PASSED);
    });

    test('a verdict with no answer has no summary to print', async () => {
        const { gate: g } = gate([NOT_YET, NOT_YET]);

        assert.equal((await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 1, 1000)).summary(), null);
    });

    test('the breach message counts the findings and names the threshold', async () => {
        const { gate: g } = gate([scanned({ critical: 1, high: 2 })]);
        const verdict = await g.await(ENDPOINT, STATUS_URL, 'tok', 'high', 300, 1000);

        assert.equal(verdict.detail, '3 open findings at high or above');
    });
});
