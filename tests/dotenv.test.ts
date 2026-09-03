import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import * as DotEnv from '../src/dotenv.js';
import { cleanup, workspace, write } from './helpers.js';

const roots: string[] = [];

function withEnv(contents: string): string {
    const root = workspace();
    roots.push(root);
    write(root, '.env', contents);

    return root;
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('DotEnv', () => {
    test('a plain assignment', () => {
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN=abc123\n'), 'DEPMAN_TOKEN'), 'abc123');
    });

    test('an exported assignment, for files people also source from a shell', () => {
        assert.equal(DotEnv.get(withEnv('export DEPMAN_TOKEN=abc123\n'), 'DEPMAN_TOKEN'), 'abc123');
    });

    test('double and single quotes are stripped', () => {
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN="abc 123"\n'), 'DEPMAN_TOKEN'), 'abc 123');
        assert.equal(DotEnv.get(withEnv("DEPMAN_TOKEN='abc 123'\n"), 'DEPMAN_TOKEN'), 'abc 123');
    });

    test('a full-line comment is not a value', () => {
        assert.equal(DotEnv.get(withEnv('# DEPMAN_TOKEN=nope\nDEPMAN_TOKEN=yes\n'), 'DEPMAN_TOKEN'), 'yes');
    });

    test('an inline comment is stripped from an unquoted value', () => {
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN=abc # the token\n'), 'DEPMAN_TOKEN'), 'abc');
    });

    test('a hash inside a value survives, because a token may contain one', () => {
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN=ab#cd\n'), 'DEPMAN_TOKEN'), 'ab#cd');
    });

    test('a hash inside a quoted value survives', () => {
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN="ab # cd"\n'), 'DEPMAN_TOKEN'), 'ab # cd');
    });

    test('an unterminated quote yields nothing rather than a guess', () => {
        // Guessing at what was meant is how a truncated token gets sent, and
        // the resulting 401 blames the server.
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN="abc\n'), 'DEPMAN_TOKEN'), null);
    });

    test('a key that is a prefix of another does not collide', () => {
        const root = withEnv('DEPMAN_TOKEN_FILE=/run/secret\nDEPMAN_TOKEN=direct\n');

        assert.equal(DotEnv.get(root, 'DEPMAN_TOKEN'), 'direct');
        assert.equal(DotEnv.get(root, 'DEPMAN_TOKEN_FILE'), '/run/secret');
    });

    test('whitespace around the key and the value is ignored', () => {
        assert.equal(DotEnv.get(withEnv('  DEPMAN_TOKEN =  abc  \n'), 'DEPMAN_TOKEN'), 'abc');
    });

    test('an empty value is nothing, not an empty string', () => {
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN=\n'), 'DEPMAN_TOKEN'), null);
    });

    test('a missing file is not an error', () => {
        const root = workspace();
        roots.push(root);

        assert.equal(DotEnv.get(root, 'DEPMAN_TOKEN'), null);
    });

    test('an absent key is null even when the file has others', () => {
        assert.equal(DotEnv.get(withEnv('OTHER=1\n'), 'DEPMAN_TOKEN'), null);
    });

    test('a file too large to be a .env is refused', () => {
        // This runs inside somebody else's npm install; a pathological file
        // must not turn a post-install hook into a memory problem.
        const root = withEnv(`PADDING=${'x'.repeat(300 * 1024)}\nDEPMAN_TOKEN=abc\n`);

        assert.equal(DotEnv.get(root, 'DEPMAN_TOKEN'), null);
    });

    test('it never writes into the process environment', () => {
        // Reading a consumer's .env must not change how their own application
        // later loads it.
        delete process.env.DEPMAN_DOTENV_CANARY;
        DotEnv.get(withEnv('DEPMAN_DOTENV_CANARY=leaked\n'), 'DEPMAN_DOTENV_CANARY');

        assert.equal(process.env.DEPMAN_DOTENV_CANARY, undefined);
    });

    test('it performs no interpolation', () => {
        // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the literal
        // ${HOME} is the point -- it must come back unexpanded.
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN=${HOME}/x\n'), 'DEPMAN_TOKEN'), '${HOME}/x');
        // biome-ignore-end lint/suspicious/noTemplateCurlyInString: as above.
    });

    test('carriage returns from a Windows-authored file are not part of the value', () => {
        assert.equal(DotEnv.get(withEnv('DEPMAN_TOKEN=abc\r\nOTHER=1\r\n'), 'DEPMAN_TOKEN'), 'abc');
    });
});
