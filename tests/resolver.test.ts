import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { purl, Resolver } from '../src/resolver.js';
import { cleanup, hiddenLockfile, recordingLogger, workspace, writeJson } from './helpers.js';

const roots: string[] = [];

function project(manifest: unknown, packages: Record<string, unknown>): string {
    const root = workspace();
    roots.push(root);
    writeJson(root, 'package.json', manifest);
    hiddenLockfile(root, packages);

    return root;
}

/** May legitimately be null: an unreadable tree is a skip, not an error. */
function maybeResolve(root: string, includeDev = true, includeOptional = true) {
    const { logger } = recordingLogger('silent');

    return new Resolver(logger).resolve(root, includeDev, includeOptional);
}

/** For the cases that must produce a tree; fails loudly rather than typing around null. */
function resolve(root: string, includeDev = true, includeOptional = true) {
    const packages = maybeResolve(root, includeDev, includeOptional);

    assert.notEqual(packages, null, 'expected a resolvable tree');

    return packages as NonNullable<typeof packages>;
}

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('purl', () => {
    test('an unscoped package', () => {
        assert.equal(purl('lodash', '4.17.21'), 'pkg:npm/lodash@4.17.21');
    });

    test('a scoped package puts the scope in the namespace, percent-encoded', () => {
        assert.equal(purl('@octokit/rest', '21.0.2'), 'pkg:npm/%40octokit/rest@21.0.2');
    });

    test('npm names keep their case', () => {
        // Ecosystem::normalizeName() lowercases Composer and Bitnami and leaves
        // npm alone, so folding case here would create a second Package row for
        // every legacy mixed-case package.
        assert.equal(purl('JSONStream', '1.3.5'), 'pkg:npm/JSONStream@1.3.5');
    });

    test('a version with metadata is encoded', () => {
        assert.equal(purl('a', '1.0.0+build.1'), 'pkg:npm/a@1.0.0%2Bbuild.1');
    });
});

describe('Resolver', () => {
    test('it is a skip, not an error, when nothing is installed', () => {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer' });

        assert.equal(maybeResolve(root), null);
    });

    test('it never falls back to the project lockfile', () => {
        // A lockfile is an intention; the hidden lockfile is what is on disk.
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer', dependencies: { a: '^1.0.0' } });
        writeJson(root, 'package-lock.json', {
            lockfileVersion: 3,
            packages: { 'node_modules/a': { version: '1.0.0' } },
        });

        assert.equal(maybeResolve(root), null);
    });

    test('it separates direct from transitive and runtime from dev', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^2.0.0' } },
            {
                'node_modules/a': { version: '1.0.0', dependencies: { b: '^1.0.0' } },
                'node_modules/b': { version: '1.5.0' },
                'node_modules/d': { version: '2.0.0', dev: true },
            },
        );

        const packages = resolve(root);

        assert.deepEqual(
            packages.map((entry) => [entry.name, entry.scope, entry.relationship, entry.depth]),
            [
                ['a', 'runtime', 'direct', 0],
                ['b', 'runtime', 'transitive', 1],
                ['d', 'dev', 'direct', 0],
            ],
        );
    });

    test('it records the constraint the root asked for, and only for direct dependencies', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'node_modules/a': { version: '1.0.0', dependencies: { b: '^1.0.0' } },
                'node_modules/b': { version: '1.5.0' },
            },
        );

        const packages = resolve(root);

        assert.equal(packages.find((entry) => entry.name === 'a')?.requestedConstraint, '^1.0.0');
        assert.equal(packages.find((entry) => entry.name === 'b')?.requestedConstraint, null);
    });

    test('include.dev false omits dev dependencies entirely', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^2.0.0' } },
            {
                'node_modules/a': { version: '1.0.0' },
                'node_modules/d': { version: '2.0.0', dev: true },
            },
        );

        assert.deepEqual(
            resolve(root, false).map((entry) => entry.name),
            ['a'],
        );
    });

    test('include.optional false omits optional dependencies entirely', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, optionalDependencies: { o: '^1.0.0' } },
            {
                'node_modules/a': { version: '1.0.0' },
                'node_modules/o': { version: '1.0.0', optional: true },
            },
        );

        assert.deepEqual(
            resolve(root, true, false).map((entry) => entry.name),
            ['a'],
        );
    });

    test('devOptional reports as optional, the more privileged of the two', () => {
        const root = project(
            { name: 'consumer', devDependencies: { d: '^1.0.0' } },
            { 'node_modules/d': { version: '1.0.0', devOptional: true } },
        );

        assert.equal(resolve(root)[0]?.scope, 'optional');
    });

    test('it skips entries with no resolvable version', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'node_modules/a': { version: '1.0.0' },
                'node_modules/ghost': { resolved: 'somewhere' },
            },
        );

        assert.deepEqual(
            resolve(root).map((entry) => entry.name),
            ['a'],
        );
    });

    test('it skips workspace links, which are the consumer’s own code', () => {
        const root = project(
            { name: 'consumer', dependencies: { web: '*' } },
            {
                'node_modules/web': { resolved: 'packages/web', link: true },
                'packages/web': { version: '1.0.0' },
            },
        );

        assert.deepEqual(resolve(root), []);
    });

    test('the root package is never a dependency of itself', () => {
        const root = project({ name: 'consumer', version: '9.9.9' }, {});

        assert.deepEqual(resolve(root), []);
    });

    test('it sorts deterministically by purl', () => {
        const root = project(
            { name: 'consumer', dependencies: { zebra: '*', apple: '*', mango: '*' } },
            {
                'node_modules/zebra': { version: '1.0.0' },
                'node_modules/apple': { version: '1.0.0' },
                'node_modules/mango': { version: '1.0.0' },
            },
        );

        assert.deepEqual(
            resolve(root).map((entry) => entry.name),
            ['apple', 'mango', 'zebra'],
        );
    });

    test('a nested copy at a different version is reported separately', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0', b: '^1.0.0' } },
            {
                'node_modules/a': { version: '1.0.0', dependencies: { shared: '^1.0.0' } },
                'node_modules/b': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
                'node_modules/shared': { version: '1.0.0' },
                'node_modules/b/node_modules/shared': { version: '2.0.0' },
            },
        );

        assert.deepEqual(
            resolve(root)
                .filter((entry) => entry.name === 'shared')
                .map((entry) => entry.version)
                .sort(),
            ['1.0.0', '2.0.0'],
        );
    });

    test('the same version installed at two paths is deduplicated on purl', () => {
        // The server deduplicates before it digests, so a client that does not
        // do it first disagrees with the server about the digest and every
        // report carries a spurious digest_mismatch.
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0', b: '^1.0.0' } },
            {
                'node_modules/a': { version: '1.0.0', dependencies: { twin: '^1.0.0' } },
                'node_modules/b': { version: '1.0.0', dependencies: { twin: '^1.0.0' } },
                'node_modules/twin': { version: '1.0.0' },
                'node_modules/b/node_modules/twin': { version: '1.0.0' },
            },
        );

        const twins = resolve(root).filter((entry) => entry.name === 'twin');

        assert.equal(twins.length, 1);
    });

    test('deduplication keeps the most privileged scope and the shallowest depth', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^1.0.0' } },
            {
                'node_modules/a': { version: '1.0.0', dependencies: { twin: '^1.0.0' } },
                'node_modules/d': { version: '1.0.0', dev: true, dependencies: { twin: '^1.0.0' } },
                'node_modules/twin': { version: '1.0.0' },
                'node_modules/d/node_modules/twin': { version: '1.0.0', dev: true },
            },
        );

        const twin = resolve(root).find((entry) => entry.name === 'twin');

        assert.equal(twin?.scope, 'runtime');
        assert.equal(twin?.depth, 1);
    });

    test('a transitive dependency carries a path back to the direct one', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'node_modules/a': { version: '1.0.0', dependencies: { b: '^1.0.0' } },
                'node_modules/b': { version: '1.0.0', dependencies: { c: '^1.0.0' } },
                'node_modules/c': { version: '1.0.0' },
            },
        );

        const packages = resolve(root);
        const c = packages.find((entry) => entry.name === 'c');

        assert.deepEqual(c?.paths, [['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0']]);
        assert.equal(c?.depth, 2);
    });

    test('a direct dependency carries no path', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            { 'node_modules/a': { version: '1.0.0' } },
        );

        assert.equal(resolve(root)[0]?.paths, undefined);
    });

    test('a chain through an excluded dev dependency is dropped whole, not shortened', () => {
        // A shortened chain would claim a parent that is not the parent.
        const root = project(
            { name: 'consumer', devDependencies: { d: '^1.0.0' } },
            {
                'node_modules/d': { version: '1.0.0', dev: true, dependencies: { under: '^1.0.0' } },
                'node_modules/under': { version: '1.0.0', dev: true },
            },
        );

        assert.deepEqual(resolve(root, false), []);
    });

    test('a package behind a workspace link is reported without an invented parent', () => {
        const root = project(
            { name: 'consumer', dependencies: { web: '*' } },
            {
                'node_modules/web': { resolved: 'packages/web', link: true },
                'node_modules/orphan': { version: '1.0.0' },
            },
        );

        const orphan = resolve(root).find((entry) => entry.name === 'orphan');

        assert.equal(orphan?.relationship, 'transitive');
        assert.equal(orphan?.paths, undefined);
    });

    test('peerDependencies count as direct, because npm installs them', () => {
        const root = project(
            { name: 'consumer', peerDependencies: { p: '^3.0.0' } },
            { 'node_modules/p': { version: '3.0.0' } },
        );

        const p = resolve(root)[0];

        assert.equal(p?.relationship, 'direct');
        assert.equal(p?.requestedConstraint, '^3.0.0');
    });

    test('a missing package.json is not an error', () => {
        const root = workspace();
        roots.push(root);
        hiddenLockfile(root, { 'node_modules/a': { version: '1.0.0' } });

        assert.deepEqual(
            resolve(root).map((entry) => entry.relationship),
            ['transitive'],
        );
    });

    test('a malformed hidden lockfile is a skip, not a throw', () => {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer' });
        writeJson(root, 'node_modules/.package-lock.json', { packages: 'not an object' });

        assert.equal(maybeResolve(root), null);
    });
});
