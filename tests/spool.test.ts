import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import type { WirePayload } from '../src/reporter.js';
import { Spool } from '../src/spool.js';
import { cleanup, recordingLogger, workspace, write } from './helpers.js';

const roots: string[] = [];

function spool(root: string, level = 'debug') {
    const { logger, sink } = recordingLogger(level);

    return { spool: new Spool(join(root, '.depman', 'spool'), logger), sink };
}

function payload(digest = 'sha256:aaa'): WirePayload {
    return { report: { manifestDigest: digest, generatedAt: '', reason: 'manual' } } as WirePayload;
}

function project(): string {
    const root = workspace();
    roots.push(root);

    return root;
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('Spool', () => {
    test('it writes a payload and reads it back', () => {
        const root = project();
        const { spool: s } = spool(root);

        assert.equal(s.write(payload('sha256:kept')), true);

        const pending = s.pending();
        assert.equal(pending.length, 1);
        assert.equal(s.read(pending[0] as string)?.report.manifestDigest, 'sha256:kept');
    });

    test('it creates the directory it needs', () => {
        const root = project();
        spool(root).spool.write(payload());

        assert.equal(readdirSync(join(root, '.depman', 'spool')).length, 1);
    });

    test('it is capped, discarding oldest first', () => {
        // A stale inventory is worth less than a recent one, and a permanently
        // offline project must not fill a disk.
        const root = project();
        const { spool: s } = spool(root);

        for (let index = 0; index < 25; index++) {
            s.write(payload(`sha256:${index}`));
        }

        assert.equal(s.pending().length, 20);
    });

    test('eviction keeps the newest, because filenames sort chronologically', () => {
        const root = project();
        const directory = join(root, '.depman', 'spool');
        const { spool: s } = spool(root);
        s.write(payload());

        // Hand-written names that bracket anything the writer produces.
        for (const name of ['19990101-000000-aaaaaaaa.json', '29990101-000000-ffffffff.json']) {
            writeFileSync(join(directory, name), JSON.stringify(payload(name)));
        }

        for (let index = 0; index < 25; index++) {
            s.write(payload(`sha256:${index}`));
        }

        const names = s.pending().map((file) => file.split('/').pop());
        assert.equal(names.includes('19990101-000000-aaaaaaaa.json'), false);
        assert.equal(names.includes('29990101-000000-ffffffff.json'), true);
    });

    test('pending() is oldest first', () => {
        const root = project();
        const directory = join(root, '.depman', 'spool');
        const { spool: s } = spool(root);
        s.write(payload());

        for (const name of ['29990101-000000-zzzzzzzz.json', '19990101-000000-aaaaaaaa.json']) {
            writeFileSync(join(directory, name), '{}');
        }

        const names = s.pending().map((file) => file.split('/').pop());
        assert.equal(names[0], '19990101-000000-aaaaaaaa.json');
        assert.equal(names[names.length - 1], '29990101-000000-zzzzzzzz.json');
    });

    test('a truncated write reads as null rather than throwing', () => {
        const root = project();
        const { spool: s } = spool(root);
        s.write(payload());
        const file = s.pending()[0] as string;
        writeFileSync(file, '{"report": {"man');

        assert.equal(s.read(file), null);
    });

    test('forget() removes a file, and forgetting a missing one is harmless', () => {
        const root = project();
        const { spool: s } = spool(root);
        s.write(payload());
        const file = s.pending()[0] as string;

        s.forget(file);
        s.forget(file);

        assert.deepEqual(s.pending(), []);
    });

    test('the token never lands in a spooled payload', () => {
        // A spool file is a dependency inventory sitting unencrypted in
        // somebody's working tree.
        const root = project();
        const { spool: s } = spool(root);
        s.write(payload());

        assert.doesNotMatch(readFileSync(s.pending()[0] as string, 'utf8'), /dpm_live_/);
    });

    test('it warns when the spool directory is not gitignored', () => {
        // Spooled files are a dependency inventory, and nobody means to commit
        // one.
        const root = project();
        write(root, '.gitignore', '/vendor\n/node_modules\n');
        const { spool: s, sink } = spool(root);
        s.write(payload());

        assert.match(sink.text(), /not in \.gitignore/);
    });

    test('it stays quiet when the spool directory is gitignored', () => {
        const root = project();
        write(root, '.gitignore', '/node_modules\n.depman/\n');
        const { spool: s, sink } = spool(root);
        s.write(payload());

        assert.doesNotMatch(sink.text(), /gitignore/);
    });

    test('pending() on a directory that does not exist is empty, not an error', () => {
        assert.deepEqual(spool(project()).spool.pending(), []);
    });
});
