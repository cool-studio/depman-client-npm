import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BREACHED, ERRORED, GateResult, PASSED, TIMED_OUT } from '../src/gate-result.js';
import { PushResult } from '../src/push-result.js';
import { Result } from '../src/result.js';

describe('Result', () => {
    test('only a rejection is a failure', () => {
        // Skipped and spooled are ordinary states: no token, no depman.json and
        // an unreachable server must not fail a consumer's build.
        assert.equal(Result.reported(1, false).isFailure(), false);
        assert.equal(Result.skipped('no token').isFailure(), false);
        assert.equal(Result.spooled('offline').isFailure(), false);
        assert.equal(Result.failed('project_mismatch').isFailure(), true);
    });

    test('a reported result carries the count, the dedupe flag and the status URL', () => {
        const result = Result.reported(42, true, 'https://depman.example/api/v1/reports/1');

        assert.equal(result.packages, 42);
        assert.equal(result.deduplicated, true);
        assert.equal(result.statusUrl, 'https://depman.example/api/v1/reports/1');
    });
});

describe('PushResult', () => {
    test('a clean drain is not a failure', () => {
        assert.equal(PushResult.drained(3, 0).isFailure(), false);
    });

    test('a drain that discarded something is a failure the user must act on', () => {
        assert.equal(PushResult.drained(2, 1).isFailure(), true);
    });

    test('stopping is the caller’s judgement, not this class’s', () => {
        assert.equal(PushResult.stopped(1, 0, 2, 'could not reach DepMan', false).isFailure(), false);
        assert.equal(PushResult.stopped(1, 0, 2, 'the token was rejected', true).isFailure(), true);
    });

    test('a skip reports nothing sent and nothing lost', () => {
        const result = PushResult.skipped('no token');

        assert.equal(result.sent, 0);
        assert.equal(result.discarded, 0);
        assert.equal(result.isFailure(), false);
    });
});

describe('GateResult', () => {
    test('exactly one outcome is a pass', () => {
        assert.equal(GateResult.passed({}).isFailure(), false);
        assert.equal(GateResult.breached(1, 'high', {}).isFailure(), true);
        assert.equal(GateResult.timedOut('ran out').isFailure(), true);
        assert.equal(GateResult.errored('no idea').isFailure(), true);
    });

    test('the exit codes distinguish "over the line" from "could not find out"', () => {
        // A pipeline that wants to retry the second and never the first has no
        // other way to tell them apart.
        assert.equal(GateResult.passed({}).exitCode(), 0);
        assert.equal(GateResult.breached(1, 'high', {}).exitCode(), 1);
        assert.equal(GateResult.timedOut('x').exitCode(), 2);
        assert.equal(GateResult.errored('x').exitCode(), 2);
    });

    test('the statuses are the four the CLI switches on', () => {
        assert.equal(GateResult.passed({}).status, PASSED);
        assert.equal(GateResult.breached(1, 'high', {}).status, BREACHED);
        assert.equal(GateResult.timedOut('x').status, TIMED_OUT);
        assert.equal(GateResult.errored('x').status, ERRORED);
    });

    test('one breaching finding reads in the singular', () => {
        assert.equal(GateResult.breached(1, 'high', {}).detail, '1 open finding at high or above');
    });

    test('a verdict with no counts has no summary', () => {
        assert.equal(GateResult.errored('x').summary(), null);
        assert.equal(GateResult.passed({ critical: 0 }).summary(), '0 critical');
    });
});
