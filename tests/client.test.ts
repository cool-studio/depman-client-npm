import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Client } from '../src/client.js';
import type { HttpResponse } from '../src/reporter.js';
import { Resolver } from '../src/resolver.js';
import { cleanup, FakeReporter, hiddenLockfile, json, recordingLogger, workspace, writeJson } from './helpers.js';

const roots: string[] = [];

const CONFIG = { project: 'storefront', endpoint: 'https://depman.example' };

function project(config: unknown = CONFIG, installed = true): string {
    const root = workspace();
    roots.push(root);

    if (config !== null) {
        writeJson(root, 'depman.json', config);
    }

    writeJson(root, 'package.json', { name: 'consumer', dependencies: { a: '^1.0.0' } });

    if (installed) {
        hiddenLockfile(root, { 'node_modules/a': { version: '1.0.0' } });
    }

    return root;
}

async function report(root: string, responses: (HttpResponse | null)[], env: Record<string, string> = {}) {
    const { logger, sink } = recordingLogger('debug');
    const reporter = new FakeReporter(responses);
    const client = new Client(logger, new Resolver(logger), reporter);
    const result = await client.report(root, 'manual', { DEPMAN_TOKEN: 'dpm_live_secret', ...env });

    return { result, sink, reporter };
}

function spooled(root: string): string[] {
    try {
        return readdirSync(join(root, '.depman', 'spool'));
    } catch {
        return [];
    }
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('Skips, which are all ordinary states', () => {
    test('no depman.json', async () => {
        const { result } = await report(project(null), []);

        assert.equal(result.status, 'skipped');
        assert.equal(result.detail, 'no depman.json');
    });

    test('disabled by configuration', async () => {
        const { result } = await report(project({ ...CONFIG, enabled: false }), []);

        assert.equal(result.status, 'skipped');
    });

    test('no project configured', async () => {
        const { result } = await report(project({ endpoint: 'https://depman.example' }), []);

        assert.equal(result.detail, 'no project configured');
    });

    test('no token, which is the normal state for a fresh clone', async () => {
        const { logger } = recordingLogger('silent');
        const client = new Client(logger, new Resolver(logger), new FakeReporter([]));
        const result = await client.report(project(), 'manual', { DEPMAN_HOME: workspace() });

        assert.equal(result.status, 'skipped');
        assert.equal(result.detail, 'no token');
        assert.equal(result.isFailure(), false);
    });

    test('nothing installed', async () => {
        const { result } = await report(project(CONFIG, false), []);

        assert.equal(result.detail, 'no installed tree');
    });
});

describe('Interpreting the response', () => {
    test('202 is reported', async () => {
        const { result } = await report(project(), [json(202, { packagesAccepted: 1, statusUrl: 'https://x/1' })]);

        assert.equal(result.status, 'reported');
        assert.equal(result.packages, 1);
        assert.equal(result.deduplicated, false);
    });

    test('200 is reported and deduplicated', async () => {
        const { result } = await report(project(), [json(200, { deduplicated: true })]);

        assert.equal(result.status, 'reported');
        assert.equal(result.deduplicated, true);
    });

    test('the statusUrl is carried back for CI gating', async () => {
        const { result } = await report(project(), [
            json(202, { statusUrl: 'https://depman.example/api/v1/reports/1' }),
        ]);

        assert.equal(result.statusUrl, 'https://depman.example/api/v1/reports/1');
    });

    test('a missing statusUrl is null, not an empty string', async () => {
        const { result } = await report(project(), [json(202, {})]);

        assert.equal(result.statusUrl, null);
    });

    test('server warnings are surfaced at warn level', async () => {
        const { sink } = await report(project(), [
            json(202, { warnings: [{ code: 'digest_mismatch', detail: 'recomputed' }] }),
        ]);

        assert.match(sink.text(), /digest_mismatch: recomputed/);
    });

    test('429 spools and is not a failure', async () => {
        // A developer adding packages one at a time will hit this, and it must
        // never look like something broke.
        const root = project();
        const { result } = await report(root, [json(429, { error: { code: 'rate_limited' } })]);

        assert.equal(result.status, 'spooled');
        assert.equal(result.isFailure(), false);
        assert.equal(spooled(root).length, 1);
    });

    test('5xx spools', async () => {
        const root = project();
        const { result } = await report(root, [json(503, { error: { code: 'ingest_paused' } })]);

        assert.equal(result.status, 'spooled');
        assert.equal(spooled(root).length, 1);
    });

    test('a transport failure spools', async () => {
        const root = project();
        const { result } = await report(root, [null]);

        assert.equal(result.status, 'spooled');
        assert.equal(spooled(root).length, 1);
    });

    test('4xx fails and is never spooled', async () => {
        // There is no point queueing something guaranteed to be rejected again;
        // retrying it forever hides the misconfiguration instead of surfacing it.
        const root = project();
        const { result } = await report(root, [
            json(409, { error: { code: 'project_mismatch', message: 'Wrong project.' } }),
        ]);

        assert.equal(result.status, 'failed');
        assert.equal(result.isFailure(), true);
        assert.match(result.detail, /project_mismatch/);
        assert.deepEqual(spooled(root), []);
    });

    test('a 4xx with no error envelope still produces a readable detail', async () => {
        const { result } = await report(project(), [{ status: 418, body: 'not json' }]);

        assert.match(result.detail, /http_418/);
    });

    test('offline.mode skip does not spool', async () => {
        const root = project({ ...CONFIG, offline: { mode: 'skip' } });
        const { result } = await report(root, [null]);

        assert.equal(result.status, 'skipped');
        assert.deepEqual(spooled(root), []);
    });
});

describe('Secrets', () => {
    test('the token appears in no log line', async () => {
        const { sink } = await report(project(), [json(202, {})]);

        assert.doesNotMatch(sink.text(), /dpm_live_secret/);
    });

    test('the token appears in no payload', async () => {
        const { reporter } = await report(project(), [json(202, {})]);

        assert.doesNotMatch(JSON.stringify(reporter.sent), /dpm_live_secret/);
    });

    test('the mechanism that supplied the token is logged, not the value', async () => {
        const { sink } = await report(project(), [json(202, {})]);

        assert.match(sink.text(), /token found via DEPMAN_TOKEN\./);
    });
});

describe('The payload it sends', () => {
    test('it carries the resolved tree and environment', async () => {
        const { reporter } = await report(project(), [json(202, {})], { DEPMAN_ENV: 'staging' });
        const payload = reporter.sent[0];

        assert.equal(payload?.environment.name, 'staging');
        assert.equal(payload?.ecosystem, 'npm');
        assert.deepEqual(
            payload?.packages.map((entry) => entry.name),
            ['a'],
        );
    });

    test('the reason names how the report was triggered', async () => {
        const { logger } = recordingLogger('silent');
        const reporter = new FakeReporter([json(202, {})]);
        await new Client(logger, new Resolver(logger), reporter).report(project(), 'postinstall', {
            DEPMAN_TOKEN: 'dpm_live_secret',
        });

        assert.equal(reporter.sent[0]?.report.reason, 'postinstall');
    });

    test('runOn.postinstall false skips a post-install report but not a manual one', async () => {
        const root = project({ ...CONFIG, runOn: { postinstall: false } });
        const { logger } = recordingLogger('silent');

        const hooked = await new Client(logger, new Resolver(logger), new FakeReporter([])).report(
            root,
            'postinstall',
            {
                DEPMAN_TOKEN: 'dpm_live_secret',
            },
        );
        assert.equal(hooked.status, 'skipped');

        const manual = await new Client(logger, new Resolver(logger), new FakeReporter([json(202, {})])).report(
            root,
            'manual',
            { DEPMAN_TOKEN: 'dpm_live_secret' },
        );
        assert.equal(manual.status, 'reported');
    });
});
