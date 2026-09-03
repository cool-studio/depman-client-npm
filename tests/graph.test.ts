import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { Graph, pathOf, segmentsOf } from '../src/graph.js';
import { cleanup, hiddenLockfile, recordingLogger, workspace } from './helpers.js';

const roots: string[] = [];

function graph(packages: Record<string, unknown>): Graph {
    const root = workspace();
    roots.push(root);
    hiddenLockfile(root, packages);

    const read = Graph.read(join(root, 'node_modules', '.package-lock.json'), recordingLogger('silent').logger);
    assert.notEqual(read, null);

    return read as Graph;
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('Install paths', () => {
    test('a top-level package', () => {
        assert.deepEqual(segmentsOf('node_modules/lodash'), ['lodash']);
    });

    test('a scoped package keeps its scope in one segment', () => {
        assert.deepEqual(segmentsOf('node_modules/@octokit/rest'), ['@octokit/rest']);
    });

    test('a nested package', () => {
        assert.deepEqual(segmentsOf('node_modules/a/node_modules/@s/b'), ['a', '@s/b']);
    });

    test('the root entry and workspace directories are not packages', () => {
        assert.equal(segmentsOf(''), null);
        assert.equal(segmentsOf('packages/web'), null);
    });

    test('segments round-trip back to a path', () => {
        for (const path of ['node_modules/a', 'node_modules/@s/b', 'node_modules/a/node_modules/b']) {
            assert.equal(pathOf(segmentsOf(path) as string[]), path);
        }
    });
});

describe('Node resolution', () => {
    test('a dependency resolves to the deepest node_modules that holds it', () => {
        const g = graph({
            'node_modules/a': { version: '1.0.0' },
            'node_modules/b': { version: '1.0.0' },
            'node_modules/a/node_modules/b': { version: '2.0.0' },
        });

        assert.equal(g.resolve(['a'], 'b'), 'node_modules/a/node_modules/b');
    });

    test('it walks outwards to the project root when nothing nearer holds it', () => {
        const g = graph({
            'node_modules/a': { version: '1.0.0' },
            'node_modules/b': { version: '1.0.0' },
        });

        assert.equal(g.resolve(['a'], 'b'), 'node_modules/b');
    });

    test('an unresolvable name is null rather than a guess', () => {
        assert.equal(graph({ 'node_modules/a': { version: '1.0.0' } }).resolve(['a'], 'ghost'), null);
    });
});

describe('Attribution', () => {
    test('a direct dependency is depth 0 with no ancestry', () => {
        const g = graph({ 'node_modules/a': { version: '1.0.0' } });
        const attributed = g.attribute(['a']);

        assert.deepEqual(attributed.get('node_modules/a'), { depth: 0, paths: [] });
    });

    test('a chain starts with the direct dependency the reader can edit', () => {
        const g = graph({
            'node_modules/a': { version: '1.0.0', dependencies: { b: '*' } },
            'node_modules/b': { version: '1.0.0', dependencies: { c: '*' } },
            'node_modules/c': { version: '1.0.0' },
        });

        assert.deepEqual(g.attribute(['a']).get('node_modules/c'), {
            depth: 2,
            paths: [['node_modules/a', 'node_modules/b']],
        });
    });

    test('devDependencies of a dependency are not walked', () => {
        // They are not installed, and walking them would attribute packages to
        // parents that could not have pulled them in.
        const g = graph({
            'node_modules/a': { version: '1.0.0', devDependencies: { ghost: '*' } },
            'node_modules/ghost': { version: '1.0.0' },
        });

        assert.equal(g.attribute(['a']).has('node_modules/ghost'), false);
    });

    test('optionalDependencies are walked, because they are installed', () => {
        const g = graph({
            'node_modules/a': { version: '1.0.0', optionalDependencies: { o: '*' } },
            'node_modules/o': { version: '1.0.0', optional: true },
        });

        assert.equal(g.attribute(['a']).get('node_modules/o')?.depth, 1);
    });

    test('a cycle terminates', () => {
        const g = graph({
            'node_modules/a': { version: '1.0.0', dependencies: { b: '*' } },
            'node_modules/b': { version: '1.0.0', dependencies: { a: '*' } },
        });

        const attributed = g.attribute(['a']);

        assert.equal(attributed.get('node_modules/a')?.depth, 0);
        assert.equal(attributed.get('node_modules/b')?.depth, 1);
    });

    test('a self-referencing package terminates', () => {
        const g = graph({ 'node_modules/a': { version: '1.0.0', dependencies: { a: '*' } } });

        assert.equal(g.attribute(['a']).get('node_modules/a')?.depth, 0);
    });

    test('it keeps at most three chains, because the server stores three', () => {
        const parents = ['p1', 'p2', 'p3', 'p4', 'p5'];
        const packages: Record<string, unknown> = { 'node_modules/shared': { version: '1.0.0' } };

        for (const parent of parents) {
            packages[`node_modules/${parent}`] = { version: '1.0.0', dependencies: { shared: '*' } };
        }

        const paths = graph(packages).attribute(parents).get('node_modules/shared')?.paths ?? [];

        assert.equal(paths.length, 3);
    });

    test('the same tree produces the same chains on every run', () => {
        const packages = {
            'node_modules/a': { version: '1.0.0', dependencies: { shared: '*' } },
            'node_modules/b': { version: '1.0.0', dependencies: { shared: '*' } },
            'node_modules/c': { version: '1.0.0', dependencies: { shared: '*' } },
            'node_modules/d': { version: '1.0.0', dependencies: { shared: '*' } },
            'node_modules/shared': { version: '1.0.0' },
        };

        const once = graph(packages).attribute(['d', 'c', 'b', 'a']).get('node_modules/shared');
        const twice = graph(packages).attribute(['a', 'b', 'c', 'd']).get('node_modules/shared');

        assert.deepEqual(once, twice);
    });

    test('a chain is a shortest one', () => {
        const g = graph({
            'node_modules/a': { version: '1.0.0', dependencies: { target: '*', b: '*' } },
            'node_modules/b': { version: '1.0.0', dependencies: { target: '*' } },
            'node_modules/target': { version: '1.0.0' },
        });

        assert.deepEqual(g.attribute(['a']).get('node_modules/target'), {
            depth: 1,
            paths: [['node_modules/a']],
        });
    });

    test('a nested duplicate is attributed to its own parent, not the top-level copy', () => {
        // Keying nodes by name rather than by install path is what gets this
        // wrong, and it is right for Composer and wrong for npm.
        const g = graph({
            'node_modules/a': { version: '1.0.0', dependencies: { shared: '^1' } },
            'node_modules/b': { version: '1.0.0', dependencies: { shared: '^2' } },
            'node_modules/shared': { version: '1.0.0' },
            'node_modules/b/node_modules/shared': { version: '2.0.0' },
        });

        const attributed = g.attribute(['a', 'b']);

        assert.deepEqual(attributed.get('node_modules/shared')?.paths, [['node_modules/a']]);
        assert.deepEqual(attributed.get('node_modules/b/node_modules/shared')?.paths, [['node_modules/b']]);
    });

    test('an unreadable file is null, so the caller reports nothing rather than guessing', () => {
        assert.equal(Graph.read('/nope/.package-lock.json', recordingLogger('silent').logger), null);
    });
});
