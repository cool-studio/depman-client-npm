import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Pusher } from '../src/pusher.js';
import type { HttpResponse, WirePayload } from '../src/reporter.js';
import { cleanup, FakeReporter, json, recordingLogger, workspace, writeJson } from './helpers.js';

const roots: string[] = [];

const CONFIG = { project: 'storefront', endpoint: 'https://depman.example' };

/** A project with `count` payloads already spooled, oldest first. */
function project(count: number, config: unknown = CONFIG): string {
    const root = workspace();
    roots.push(root);
    writeJson(root, 'depman.json', config);

    // Explicit filenames rather than Spool.write(), so the test pins the drain
    // order rather than the writer's clock resolution.
    mkdirSync(join(root, '.depman', 'spool'), { recursive: true });

    for (let index = 0; index < count; index++) {
        writeFileSync(
            join(root, '.depman', 'spool', `2026010${index}-000000-000-aaaaaaaa.json`),
            JSON.stringify({
                report: { manifestDigest: `sha256:${index}`, generatedAt: '', reason: 'postinstall' },
            } satisfies Partial<WirePayload>),
        );
    }

    return root;
}

function remaining(root: string): number {
    try {
        return readdirSync(join(root, '.depman', 'spool')).length;
    } catch {
        return 0;
    }
}

async function push(root: string, responses: (HttpResponse | null)[], env: Record<string, string> = {}) {
    const { logger, sink } = recordingLogger('debug');
    const reporter = new FakeReporter(responses);
    const result = await new Pusher(logger, reporter).push(root, { DEPMAN_TOKEN: 'dpm_live_secret', ...env });

    return { result, sink, reporter };
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('Draining the spool', () => {
    test('an empty spool is a no-op', async () => {
        const { result } = await push(project(0), []);

        assert.equal(result.status, 'drained');
        assert.equal(result.sent, 0);
        assert.equal(result.discarded, 0);
    });

    test('it sends everything and deletes what the server accepted', async () => {
        const root = project(3);
        const { result } = await push(root, [json(202, {}), json(200, {}), json(202, {})]);

        assert.equal(result.status, 'drained');
        assert.equal(result.sent, 3);
        assert.equal(remaining(root), 0);
    });

    test('it replays oldest first', async () => {
        const root = project(3);
        const { reporter } = await push(root, [json(202, {}), json(202, {}), json(202, {})]);

        assert.deepEqual(
            reporter.sent.map((payload) => payload.report.manifestDigest),
            ['sha256:0', 'sha256:1', 'sha256:2'],
        );
    });

    test('every replayed payload is marked spool-replay', async () => {
        // The only way the server can tell a tree that arrived late from one
        // that arrived now. Safe because the digest covers semantic content
        // only, so a replay still deduplicates.
        const root = project(2);
        const { reporter } = await push(root, [json(202, {}), json(202, {})]);

        assert.deepEqual(
            reporter.sent.map((payload) => payload.report.reason),
            ['spool-replay', 'spool-replay'],
        );
    });

    test('a transport failure stops the drain and discards nothing', async () => {
        const root = project(3);
        const { result } = await push(root, [json(202, {}), null]);

        assert.equal(result.status, 'stopped');
        assert.equal(result.sent, 1);
        assert.equal(result.discarded, 0);
        assert.equal(result.remaining, 2);
        assert.equal(result.isFailure(), false);
        assert.equal(remaining(root), 2);
    });

    test('429 stops the drain and is not a failure', async () => {
        // Every remaining payload goes to the same host with the same token, so
        // working through the queue turns a rate limit into an outage of the
        // client's own making.
        const root = project(3);
        const { result } = await push(root, [json(429, { error: { code: 'rate_limited' } })]);

        assert.equal(result.status, 'stopped');
        assert.equal(result.detail, 'rate limited');
        assert.equal(result.isFailure(), false);
        assert.equal(remaining(root), 3);
    });

    test('5xx stops the drain and is not a failure', async () => {
        const root = project(3);
        const { result } = await push(root, [json(503, {})]);

        assert.equal(result.status, 'stopped');
        assert.equal(result.isFailure(), false);
        assert.equal(remaining(root), 3);
    });

    for (const status of [401, 403]) {
        test(`${status} keeps the whole queue and is a failure`, async () => {
            // An auth problem is fixable, and fixable once for the whole queue.
            // Discarding here would lose an entire inventory to a rotated token.
            const root = project(3);
            const { result, sink } = await push(root, [json(status, { error: { code: 'invalid_token' } })]);

            assert.equal(result.status, 'stopped');
            assert.equal(result.discarded, 0);
            assert.equal(result.isFailure(), true);
            assert.equal(remaining(root), 3);
            assert.match(sink.text(), /Nothing was discarded/);
        });
    }

    test('any other 4xx discards that payload, loudly, and continues', async () => {
        // A permanent property of that payload, not of the queue. Retrying it
        // forever hides the misconfiguration and evicts payloads that could be
        // delivered.
        const root = project(3);
        const { result, sink } = await push(root, [
            json(422, { error: { code: 'validation_failed', message: 'Bad envelope.' } }),
            json(202, {}),
            json(202, {}),
        ]);

        assert.equal(result.status, 'drained');
        assert.equal(result.sent, 2);
        assert.equal(result.discarded, 1);
        assert.equal(result.isFailure(), true);
        assert.equal(remaining(root), 0);
        assert.match(sink.text(), /validation_failed/);
    });

    test('a 3xx stops the drain and discards nothing', async () => {
        // Section 7 forbids following redirects, so this is a misconfigured
        // endpoint rather than a bad payload -- and a proxy answering 302 must
        // not be able to eat a whole spool one file at a time.
        const root = project(3);
        const { result, sink } = await push(root, [{ status: 302, body: '' }]);

        assert.equal(result.status, 'stopped');
        assert.equal(result.discarded, 0);
        assert.equal(result.isFailure(), true);
        assert.equal(remaining(root), 3);
        assert.match(sink.text(), /redirecting/);
    });

    test('a payload that cannot be decoded is discarded and the drain continues', async () => {
        const root = project(1);
        writeFileSync(join(root, '.depman', 'spool', '19990101-000000-000-aaaaaaaa.json'), '{"trunc');

        const { result, sink } = await push(root, [json(202, {})]);

        assert.equal(result.status, 'drained');
        assert.equal(result.sent, 1);
        assert.equal(result.discarded, 1);
        assert.equal(remaining(root), 0);
        assert.match(sink.text(), /could not be read/);
    });

    test('no token leaves the spool exactly as it was', async () => {
        // Discarding an inventory because this invocation had no credential
        // would throw away the thing the spool exists to protect.
        const root = project(2);
        const { logger } = recordingLogger('silent');
        const result = await new Pusher(logger, new FakeReporter([])).push(root, { DEPMAN_HOME: workspace() });

        assert.equal(result.status, 'skipped');
        assert.equal(result.detail, 'no token');
        assert.equal(result.isFailure(), false);
        assert.equal(remaining(root), 2);
    });

    test('no depman.json is a skip', async () => {
        const root = workspace();
        roots.push(root);
        const { logger } = recordingLogger('silent');

        assert.equal((await new Pusher(logger, new FakeReporter([])).push(root)).detail, 'no depman.json');
    });

    test('disabled by configuration is a skip', async () => {
        const { result } = await push(project(2, { ...CONFIG, enabled: false }), []);

        assert.equal(result.status, 'skipped');
    });

    test('the token appears in no log line', async () => {
        const { sink } = await push(project(1), [json(202, {})]);

        assert.doesNotMatch(sink.text(), /dpm_live_secret/);
    });

    test('it never touches the installed tree', async () => {
        // A push runs long after the install that produced the payload, when
        // node_modules may look nothing like it did.
        const root = project(1);
        const { result } = await push(root, [json(202, {})]);

        assert.equal(result.sent, 1);
    });
});
