import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { Config } from '../src/config.js';
import { cleanup, recordingLogger, workspace, write, writeJson } from './helpers.js';

const roots: string[] = [];

function project(config: unknown = {}, dotEnv: string | null = null): string {
    const root = workspace();
    roots.push(root);

    if (config !== null) {
        writeJson(root, 'depman.json', config);
    }

    if (dotEnv !== null) {
        write(root, '.env', dotEnv);
    }

    return root;
}

function load(root: string, level = 'debug') {
    const { logger, sink } = recordingLogger(level);

    return { config: Config.load(root, logger), sink };
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('Config precedence', () => {
    test('.env beats the process environment, which beats depman.json, which beats the default', () => {
        const all = project({ endpoint: 'https://from-file' }, 'DEPMAN_ENDPOINT=https://from-dotenv\n');
        assert.equal(load(all).config?.endpoint({ DEPMAN_ENDPOINT: 'https://from-env' }), 'https://from-dotenv');

        const noDotEnv = project({ endpoint: 'https://from-file' });
        assert.equal(load(noDotEnv).config?.endpoint({ DEPMAN_ENDPOINT: 'https://from-env' }), 'https://from-env');

        assert.equal(load(noDotEnv).config?.endpoint(), 'https://from-file');

        assert.equal(load(project()).config?.endpoint(), 'https://depman.io');
    });

    test('the endpoint default is the apex host, not an api. subdomain', () => {
        assert.equal(load(project()).config?.endpoint(), 'https://depman.io');
    });

    test('a trailing slash is stripped from the endpoint', () => {
        assert.equal(
            load(project({ endpoint: 'https://depman.example/' })).config?.endpoint(),
            'https://depman.example',
        );
    });

    test('an empty value falls through rather than blanking the setting', () => {
        const root = project({ project: 'from-file' });

        assert.equal(load(root).config?.project({ DEPMAN_PROJECT: '' }), 'from-file');
    });

    test('sourceOf names the winner, which is the question doctor exists to answer', () => {
        const withDotEnv = project({ endpoint: 'https://f' }, 'DEPMAN_ENDPOINT=https://d\n');
        assert.equal(load(withDotEnv).config?.sourceOf('endpoint', 'DEPMAN_ENDPOINT'), '.env');

        const withFile = project({ endpoint: 'https://f' });
        assert.equal(
            load(withFile).config?.sourceOf('endpoint', 'DEPMAN_ENDPOINT', { DEPMAN_ENDPOINT: 'https://e' }),
            'DEPMAN_ENDPOINT',
        );
        assert.equal(load(withFile).config?.sourceOf('endpoint', 'DEPMAN_ENDPOINT'), 'depman.json');
        assert.equal(load(project()).config?.sourceOf('endpoint', 'DEPMAN_ENDPOINT'), 'the default');
    });
});

describe('Bounded .env reads', () => {
    test('environment.from cannot pull an arbitrary secret out of .env', () => {
        // depman.json is committed and reviewed far less carefully than code.
        // Without the allowlist a one-line change to that array would read a
        // secret out of the densest secret store in the project and ship it as
        // an environment name.
        const root = project({ environment: { from: ['DB_PASSWORD'] } }, 'DB_PASSWORD=hunter2\n');

        assert.deepEqual(load(root).config?.environment(), { name: 'local', resolvedFrom: 'fallback' });
    });

    test('a non-allowlisted variable is still read from the process environment', () => {
        // The bound applies to .env alone. The process environment is set
        // deliberately by whoever runs the install.
        const root = project({ environment: { from: ['MY_OWN_VAR'] } });

        assert.deepEqual(load(root).config?.environment({ MY_OWN_VAR: 'staging' }), {
            name: 'staging',
            resolvedFrom: 'MY_OWN_VAR',
        });
    });

    test('APP_ENV is on the allowlist, because it is the variable that matters', () => {
        const root = project({ environment: { from: ['APP_ENV'] } }, 'APP_ENV=production\n');

        assert.deepEqual(load(root).config?.environment(), { name: 'production', resolvedFrom: 'APP_ENV' });
    });

    test('the client’s own namespace needs no allowlist', () => {
        const root = project({}, 'DEPMAN_ENV=staging\n');

        assert.equal(load(root).config?.environment().name, 'staging');
    });
});

describe('Environment resolution', () => {
    test('from is walked in order and the first non-empty value wins', () => {
        const root = project({ environment: { from: ['FIRST', 'SECOND'] } });

        assert.deepEqual(load(root).config?.environment({ SECOND: 'staging' }), {
            name: 'staging',
            resolvedFrom: 'SECOND',
        });
    });

    test('values are trimmed and lowercased', () => {
        const root = project({});

        assert.equal(load(root).config?.environment({ DEPMAN_ENV: '  PRODUCTION  ' }).name, 'production');
    });

    test('map rewrites a value', () => {
        const root = project({ environment: { map: { prod: 'production' } } });

        assert.equal(load(root).config?.environment({ DEPMAN_ENV: 'prod' }).name, 'production');
    });

    test('a value outside allowed is coerced to the fallback, with a warning', () => {
        // Coerce rather than invent an environment; typos would otherwise
        // proliferate into environments nobody meant to create.
        const root = project({ environment: { allowed: ['production'], fallback: 'local' } });
        const { config, sink } = load(root);

        assert.equal(config?.environment({ DEPMAN_ENV: 'prodcution' }).name, 'local');
        assert.match(sink.text(), /not in the allowed list/);
    });

    test('the fallback is local and never production', () => {
        // Mislabelling a laptop as production produces alerts nobody asked for
        // and buries the ones that matter.
        assert.deepEqual(load(project()).config?.environment(), { name: 'local', resolvedFrom: 'fallback' });
    });

    test('resolvedFrom names the variable, or fallback', () => {
        assert.equal(load(project()).config?.environment({ DEPMAN_ENV: 'ci' }).resolvedFrom, 'DEPMAN_ENV');
        assert.equal(load(project()).config?.environment().resolvedFrom, 'fallback');
    });
});

describe('Committed credentials', () => {
    for (const key of ['token', 'apiToken', 'api_token', 'secret']) {
        test(`a "${key}" key is refused loudly, regardless of log level`, () => {
            // The file is committed, so a token in it is already leaked and
            // staying quiet helps nobody.
            const root = project({ [key]: 'dpm_live_leaked' });
            const { sink } = load(root, 'silent');

            assert.match(sink.text(), new RegExp(`"${key}"`));
            assert.match(sink.text(), /Rotate that token/);
        });
    }

    test('the refused value is never used as a token', () => {
        const root = project({ token: 'dpm_live_leaked' });
        const { sink } = load(root, 'silent');

        assert.doesNotMatch(sink.text().replace(/"token"/, ''), /dpm_live_leaked/);
    });
});

describe('Other settings', () => {
    test('a missing depman.json is a silent skip, not an error', () => {
        const root = workspace();
        roots.push(root);
        const { config, sink } = load(root, 'warn');

        assert.equal(config, null);
        assert.equal(sink.text(), '');
    });

    test('malformed JSON is reported and skipped, never thrown', () => {
        const root = workspace();
        roots.push(root);
        write(root, 'depman.json', '{ not json');
        const { config, sink } = load(root);

        assert.equal(config, null);
        assert.match(sink.text(), /not valid JSON/);
    });

    test('the kill switch turns everything off', () => {
        assert.equal(load(project({ enabled: false })).config?.isEnabled(), false);
        assert.equal(load(project()).config?.isEnabled({ DEPMAN_ENABLED: 'false' }), false);
        assert.equal(load(project()).config?.isEnabled(), true);
    });

    test('the timeout is clamped rather than honoured', () => {
        // An absurd configured value is a typo, and a hook that holds an
        // install open for ten minutes is worse than one that gives up.
        assert.equal(load(project({ timeoutMs: 999999 })).config?.timeoutMs(), 60000);
        assert.equal(load(project({ timeoutMs: 1 })).config?.timeoutMs(), 1000);
        assert.equal(load(project()).config?.timeoutMs(), 10000);
    });

    test('include.dev and include.optional default to true', () => {
        assert.equal(load(project()).config?.includeDev(), true);
        assert.equal(load(project()).config?.includeOptional(), true);
        assert.equal(load(project({ include: { dev: false, optional: false } })).config?.includeDev(), false);
        assert.equal(load(project({ include: { dev: false, optional: false } })).config?.includeOptional(), false);
    });

    test('offline.mode falls back to spool for anything unrecognised', () => {
        assert.equal(load(project({ offline: { mode: 'skip' } })).config?.offlineMode(), 'skip');
        assert.equal(load(project({ offline: { mode: 'nonsense' } })).config?.offlineMode(), 'spool');
        assert.equal(load(project()).config?.offlineMode(), 'spool');
    });

    test('the spool directory is resolved against the project root', () => {
        const root = project();

        assert.equal(load(root).config?.spoolDirectory(), `${root}/.depman/spool`);
    });

    test('an unknown key from a newer client is ignored, never rejected', () => {
        const root = project({ project: 'x', somethingFromTheFuture: { deeply: 'nested' } });

        assert.equal(load(root).config?.project(), 'x');
    });
});
