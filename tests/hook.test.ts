import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import * as Hook from '../src/hook.js';
import { cleanup, workspace, write, writeJson } from './helpers.js';

/**
 * Section 0: a client MUST NOT break the build it runs inside.
 *
 * Everything else in the specification is downstream of this one. The hook
 * fires from a consumer's `npm install`; a dependency-inventory tool that
 * fails installs gets removed, and then it protects nobody.
 *
 * Each case below is a project shaped in a way that could plausibly throw. None
 * of them may. Keep this suite honest if you touch the handler.
 */
const roots: string[] = [];

function project(build: (root: string) => void): string {
    const root = workspace();
    roots.push(root);
    build(root);

    return root;
}

/** Hostile shapes, each one a way a real consumer's project has been wrong. */
const HOSTILE: Array<[string, (root: string) => void]> = [
    ['no depman.json at all', () => {}],
    ['depman.json is not JSON', (root) => write(root, 'depman.json', '{ nope')],
    ['depman.json is an array', (root) => write(root, 'depman.json', '[1, 2, 3]')],
    ['depman.json is a bare string', (root) => write(root, 'depman.json', '"hello"')],
    ['depman.json is null', (root) => write(root, 'depman.json', 'null')],
    ['depman.json is empty', (root) => write(root, 'depman.json', '')],
    [
        'every value is the wrong type',
        (root) =>
            writeJson(root, 'depman.json', {
                project: 42,
                endpoint: [],
                timeoutMs: 'soon',
                include: 'yes',
                environment: 'production',
                offline: 7,
                logLevel: {},
                enabled: 'maybe',
            }),
    ],
    [
        'environment.from is not a list of strings',
        (root) => writeJson(root, 'depman.json', { project: 'p', environment: { from: [{}, 5, null] } }),
    ],
    [
        'a credential is committed, which must warn and continue',
        (root) => writeJson(root, 'depman.json', { project: 'p', token: 'dpm_live_leaked' }),
    ],
    [
        'node_modules exists but the hidden lockfile does not',
        (root) => {
            writeJson(root, 'depman.json', { project: 'p' });
            write(root, 'node_modules/.keep', '');
        },
    ],
    [
        'the hidden lockfile is not JSON',
        (root) => {
            writeJson(root, 'depman.json', { project: 'p' });
            write(root, 'node_modules/.package-lock.json', '{ truncated');
        },
    ],
    [
        'the hidden lockfile has entries of the wrong shape',
        (root) => {
            writeJson(root, 'depman.json', { project: 'p' });
            writeJson(root, 'node_modules/.package-lock.json', {
                packages: { 'node_modules/a': 'not an object', 'node_modules/b': null, '': { version: '1.0.0' } },
            });
        },
    ],
    [
        'package.json is unreadable',
        (root) => {
            writeJson(root, 'depman.json', { project: 'p' });
            write(root, 'package.json', '{{{');
            writeJson(root, 'node_modules/.package-lock.json', {
                packages: { 'node_modules/a': { version: '1.0.0' } },
            });
        },
    ],
    [
        'the endpoint is unreachable',
        (root) => {
            // 127.0.0.1:1 refuses immediately, so this exercises the transport
            // failure path without a network round trip.
            writeJson(root, 'depman.json', {
                project: 'p',
                endpoint: 'http://127.0.0.1:1',
                timeoutMs: 1000,
            });
            writeJson(root, 'node_modules/.package-lock.json', {
                packages: { 'node_modules/a': { version: '1.0.0' } },
            });
        },
    ],
    [
        'the endpoint is not a URL at all',
        (root) => {
            writeJson(root, 'depman.json', { project: 'p', endpoint: 'not a url', timeoutMs: 1000 });
            writeJson(root, 'node_modules/.package-lock.json', {
                packages: { 'node_modules/a': { version: '1.0.0' } },
            });
        },
    ],
    [
        'the spool directory cannot be created',
        (root) => {
            writeJson(root, 'depman.json', {
                project: 'p',
                endpoint: 'http://127.0.0.1:1',
                timeoutMs: 1000,
                offline: { spoolDir: '/proc/version/nope' },
            });
            writeJson(root, 'node_modules/.package-lock.json', {
                packages: { 'node_modules/a': { version: '1.0.0' } },
            });
        },
    ],
];

beforeEach(() => {
    // Set what the assertions depend on rather than inheriting it: a suite that
    // relies on the host application's configuration is a suite that passes
    // here and fails everywhere else.
    process.env.DEPMAN_LOG_LEVEL = 'silent';
    process.env.DEPMAN_TOKEN = 'dpm_live_secret';
    delete process.env.DEPMAN_DEBUG;
});

after(() => {
    delete process.env.DEPMAN_LOG_LEVEL;
    delete process.env.DEPMAN_TOKEN;
    delete process.env.INIT_CWD;

    for (const root of roots) {
        cleanup(root);
    }
});

describe('The hook never breaks the build', () => {
    for (const [name, build] of HOSTILE) {
        test(name, async () => {
            process.env.INIT_CWD = project(build);

            // The assertion is that this resolves at all. Any throw escaping
            // here would abort a consumer's npm install.
            await Hook.report();
        });
    }
});

describe('Project root resolution', () => {
    test('INIT_CWD wins, because npm runs the script from inside node_modules', () => {
        const root = project(() => {});
        process.env.INIT_CWD = root;

        assert.equal(Hook.projectRoot(), root);
    });

    test('a missing INIT_CWD falls back to the working directory', () => {
        delete process.env.INIT_CWD;

        assert.equal(Hook.projectRoot(), process.cwd());
    });

    test('an INIT_CWD pointing at nothing falls back to the working directory', () => {
        process.env.INIT_CWD = '/definitely/not/here';

        assert.equal(Hook.projectRoot(), process.cwd());
    });

    test('an empty INIT_CWD falls back to the working directory', () => {
        process.env.INIT_CWD = '';

        assert.equal(Hook.projectRoot(), process.cwd());
    });
});
