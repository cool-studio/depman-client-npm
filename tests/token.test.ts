import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import * as Token from '../src/token.js';
import { cleanup, workspace, write, writeJson } from './helpers.js';

const roots: string[] = [];

function project(): string {
    const root = workspace();
    roots.push(root);

    return root;
}

const ENDPOINT = 'https://depman.example';

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('Token discovery', () => {
    test('1: DEPMAN_TOKEN in the project .env', () => {
        // First, because the hook fires during npm install when the consumer's
        // framework has not booted and nothing has loaded .env.
        const root = project();
        write(root, '.env', 'DEPMAN_TOKEN=from-dotenv\n');

        assert.deepEqual(Token.locate(ENDPOINT, {}, root), { value: 'from-dotenv', source: '.env' });
    });

    test('2: DEPMAN_TOKEN in the process environment', () => {
        const root = project();

        assert.deepEqual(Token.locate(ENDPOINT, { DEPMAN_TOKEN: 'from-env' }, root), {
            value: 'from-env',
            source: 'DEPMAN_TOKEN',
        });
    });

    test('3: DEPMAN_TOKEN_FILE, for secret mounts', () => {
        const root = project();
        const secret = write(root, 'secret.txt', 'from-file\n');

        const found = Token.locate(ENDPOINT, { DEPMAN_TOKEN_FILE: secret }, root);

        assert.equal(found?.value, 'from-file');
        assert.match(found?.source ?? '', /^DEPMAN_TOKEN_FILE \(/);
    });

    test('4: ~/.depman/credentials, keyed by endpoint host', () => {
        const root = project();
        const home = project();
        writeJson(home, '.depman/credentials', {
            'depman.example': 'from-credentials',
            'other.example': 'wrong-one',
        });

        assert.deepEqual(Token.locate(ENDPOINT, { DEPMAN_HOME: home }, root), {
            value: 'from-credentials',
            source: '~/.depman/credentials',
        });
    });

    test('.env beats the process environment', () => {
        const root = project();
        write(root, '.env', 'DEPMAN_TOKEN=from-dotenv\n');

        assert.equal(Token.locate(ENDPOINT, { DEPMAN_TOKEN: 'from-env' }, root)?.value, 'from-dotenv');
    });

    test('the process environment beats a token file', () => {
        const root = project();
        const secret = write(root, 'secret.txt', 'from-file');

        assert.equal(
            Token.locate(ENDPOINT, { DEPMAN_TOKEN: 'from-env', DEPMAN_TOKEN_FILE: secret }, root)?.value,
            'from-env',
        );
    });

    test('a token file beats the credentials file', () => {
        const root = project();
        const home = project();
        const secret = write(root, 'secret.txt', 'from-file');
        writeJson(home, '.depman/credentials', { 'depman.example': 'from-credentials' });

        assert.equal(
            Token.locate(ENDPOINT, { DEPMAN_TOKEN_FILE: secret, DEPMAN_HOME: home }, root)?.value,
            'from-file',
        );
    });

    test('DEPMAN_TOKEN_FILE is itself read from .env before the process environment', () => {
        const root = project();
        const preferred = write(root, 'preferred.txt', 'from-dotenv-path');
        const other = write(root, 'other.txt', 'from-env-path');
        write(root, '.env', `DEPMAN_TOKEN_FILE=${preferred}\n`);

        assert.equal(Token.locate(ENDPOINT, { DEPMAN_TOKEN_FILE: other }, root)?.value, 'from-dotenv-path');
    });

    test('no token anywhere is null, which the caller treats as a skip', () => {
        // The normal state for an open-source contributor who just cloned the
        // repository. It must be harmless.
        const root = project();

        assert.equal(Token.locate(ENDPOINT, { DEPMAN_HOME: project() }, root), null);
    });

    test('the credentials file does not answer for a different host', () => {
        const root = project();
        const home = project();
        writeJson(home, '.depman/credentials', { 'somewhere.else': 'not-yours' });

        assert.equal(Token.locate(ENDPOINT, { DEPMAN_HOME: home }, root), null);
    });

    test('an unreadable token file falls through rather than throwing', () => {
        const root = project();

        assert.equal(
            Token.locate(ENDPOINT, { DEPMAN_TOKEN_FILE: '/nope/missing', DEPMAN_HOME: project() }, root),
            null,
        );
    });

    test('a malformed credentials file falls through rather than throwing', () => {
        const root = project();
        const home = project();
        write(home, '.depman/credentials', 'not json at all');

        assert.equal(Token.locate(ENDPOINT, { DEPMAN_HOME: home }, root), null);
    });

    test('an empty token file is not a token', () => {
        const root = project();
        const secret = write(root, 'secret.txt', '   \n');

        assert.equal(Token.locate(ENDPOINT, { DEPMAN_TOKEN_FILE: secret, DEPMAN_HOME: project() }, root), null);
    });

    test('find() returns the value alone, for callers that do not report provenance', () => {
        const root = project();

        assert.equal(Token.find(ENDPOINT, { DEPMAN_TOKEN: 'plain' }, root), 'plain');
    });
});
