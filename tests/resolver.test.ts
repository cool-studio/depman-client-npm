import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { purl, Resolver } from '../src/resolver.js';
import { extractInlinedState, versionOf } from '../src/resolvers/yarn-pnp.js';
import {
    cleanup,
    hiddenLockfile,
    inlinePnpState,
    link,
    pnpmTree,
    recordingLogger,
    workspace,
    write,
    writeJson,
} from './helpers.js';

const roots: string[] = [];

function project(manifest: unknown, packages: Record<string, unknown>): string {
    const root = workspace();
    roots.push(root);
    writeJson(root, 'package.json', manifest);
    hiddenLockfile(root, packages);

    return root;
}

function resolveWith(root: string, includeDev = true, includeOptional = true) {
    const { logger, sink } = recordingLogger();

    return { resolution: new Resolver(logger).resolve(root, includeDev, includeOptional), sink };
}

/** May legitimately be null: an unreadable tree is a skip, not an error. */
function maybeResolve(root: string, includeDev = true, includeOptional = true) {
    const { logger } = recordingLogger('silent');
    const resolution = new Resolver(logger).resolve(root, includeDev, includeOptional);

    return resolution.outcome === 'resolved' ? resolution.packages : null;
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

    test('an npm-installed tree names npm as the manager', () => {
        const root = project(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            { 'node_modules/a': { version: '1.0.0' } },
        );

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');
        assert.equal(resolution.outcome === 'resolved' && resolution.packageManager.name, 'npm');
        assert.equal(resolution.outcome === 'resolved' && resolution.packageManager.lockfileName, 'package-lock.json');
    });
});

describe('pnpm resolution', () => {
    function pnpmProject(
        manifest: unknown,
        instances: Parameters<typeof pnpmTree>[1],
        topLevel: Record<string, string>,
        modulesYaml?: string,
    ): string {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', manifest);

        if (modulesYaml === undefined) {
            pnpmTree(root, instances, topLevel);
        } else {
            pnpmTree(root, instances, topLevel, modulesYaml);
        }

        return root;
    }

    test('it resolves a virtual store: scopes, relationships, attribution and the manager', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^2.0.0' } },
            {
                'a@1.0.0': {
                    manifest: { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } },
                    links: { b: 'b@1.5.0' },
                },
                'b@1.5.0': { manifest: { name: 'b', version: '1.5.0' } },
                'd@2.0.0': { manifest: { name: 'd', version: '2.0.0' } },
            },
            { a: 'a@1.0.0', d: 'd@2.0.0' },
        );

        const { resolution } = resolveWith(root);
        assert.equal(resolution.outcome, 'resolved');

        if (resolution.outcome !== 'resolved') {
            return;
        }

        assert.deepEqual(resolution.packageManager, {
            name: 'pnpm',
            version: '9.12.0',
            lockfileName: 'pnpm-lock.yaml',
        });
        assert.deepEqual(
            resolution.packages.map((entry) => [entry.name, entry.scope, entry.relationship, entry.depth]),
            [
                ['a', 'runtime', 'direct', 0],
                ['b', 'runtime', 'transitive', 1],
                ['d', 'dev', 'direct', 0],
            ],
        );
        assert.equal(resolution.packages[0]?.requestedConstraint, '^1.0.0');
        assert.deepEqual(resolution.packages[1]?.paths, [['pkg:npm/a@1.0.0']]);
    });

    test('a deeper transitive carries a chain of purls back to the direct dependency', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'a@1.0.0': {
                    manifest: { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } },
                    links: { b: 'b@1.0.0' },
                },
                'b@1.0.0': {
                    manifest: { name: 'b', version: '1.0.0', dependencies: { c: '^1.0.0' } },
                    links: { c: 'c@1.0.0' },
                },
                'c@1.0.0': { manifest: { name: 'c', version: '1.0.0' } },
            },
            { a: 'a@1.0.0' },
        );

        const packages = resolve(root);
        const c = packages.find((entry) => entry.name === 'c');

        assert.equal(c?.depth, 2);
        assert.deepEqual(c?.paths, [['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0']]);
    });

    test('an optionalDependencies link makes the subtree optional', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'a@1.0.0': {
                    manifest: { name: 'a', version: '1.0.0', optionalDependencies: { o: '^1.0.0' } },
                    links: { o: 'o@1.0.0' },
                },
                'o@1.0.0': {
                    manifest: { name: 'o', version: '1.0.0', dependencies: { u: '^1.0.0' } },
                    links: { u: 'u@1.0.0' },
                },
                'u@1.0.0': { manifest: { name: 'u', version: '1.0.0' } },
            },
            { a: 'a@1.0.0' },
        );

        const scopes = new Map(resolve(root).map((entry) => [entry.name, entry.scope]));

        assert.equal(scopes.get('a'), 'runtime');
        assert.equal(scopes.get('o'), 'optional');
        assert.equal(scopes.get('u'), 'optional');
    });

    test('reached both as dev and through an optional route reports optional, like npm devOptional', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^1.0.0' } },
            {
                'a@1.0.0': {
                    manifest: { name: 'a', version: '1.0.0', optionalDependencies: { x: '^1.0.0' } },
                    links: { x: 'x@1.0.0' },
                },
                'd@1.0.0': {
                    manifest: { name: 'd', version: '1.0.0', dependencies: { x: '^1.0.0' } },
                    links: { x: 'x@1.0.0' },
                },
                'x@1.0.0': { manifest: { name: 'x', version: '1.0.0' } },
            },
            { a: 'a@1.0.0', d: 'd@1.0.0' },
        );

        assert.equal(resolve(root).find((entry) => entry.name === 'x')?.scope, 'optional');
    });

    test('include.dev false omits dev dependencies and their chains entirely', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^1.0.0' } },
            {
                'a@1.0.0': { manifest: { name: 'a', version: '1.0.0' } },
                'd@1.0.0': {
                    manifest: { name: 'd', version: '1.0.0', dependencies: { under: '^1.0.0' } },
                    links: { under: 'under@1.0.0' },
                },
                'under@1.0.0': { manifest: { name: 'under', version: '1.0.0' } },
            },
            { a: 'a@1.0.0', d: 'd@1.0.0' },
        );

        // `under` is only reachable through a dev dependency, so it is dev
        // itself and goes with it -- the same outcome the npm reader produces.
        assert.deepEqual(
            resolve(root, false).map((entry) => entry.name),
            ['a'],
        );
    });

    test('peer-variant instances of one version deduplicate on purl', () => {
        // pnpm installs one instance per peer combination; they are the same
        // package version and must not digest as two.
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', b: '^1.0.0' } },
            {
                'a@1.0.0': {
                    manifest: { name: 'a', version: '1.0.0', dependencies: { peered: '^1.0.0' } },
                    links: { peered: 'peered@1.0.0(x@1.0.0)' },
                },
                'b@1.0.0': {
                    manifest: { name: 'b', version: '1.0.0', dependencies: { peered: '^1.0.0' } },
                    links: { peered: 'peered@1.0.0(y@1.0.0)' },
                },
                'peered@1.0.0(x@1.0.0)': { manifest: { name: 'peered', version: '1.0.0' } },
                'peered@1.0.0(y@1.0.0)': { manifest: { name: 'peered', version: '1.0.0' } },
            },
            { a: 'a@1.0.0', b: 'b@1.0.0' },
        );

        assert.equal(resolve(root).filter((entry) => entry.name === 'peered').length, 1);
    });

    test('two installed versions are reported separately, each with its own parent', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', b: '^1.0.0' } },
            {
                'a@1.0.0': {
                    manifest: { name: 'a', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
                    links: { shared: 'shared@1.0.0' },
                },
                'b@1.0.0': {
                    manifest: { name: 'b', version: '1.0.0', dependencies: { shared: '^2.0.0' } },
                    links: { shared: 'shared@2.0.0' },
                },
                'shared@1.0.0': { manifest: { name: 'shared', version: '1.0.0' } },
                'shared@2.0.0': { manifest: { name: 'shared', version: '2.0.0' } },
            },
            { a: 'a@1.0.0', b: 'b@1.0.0' },
        );

        const shared = resolve(root).filter((entry) => entry.name === 'shared');

        assert.deepEqual(shared.map((entry) => entry.version).sort(), ['1.0.0', '2.0.0']);
        assert.deepEqual(shared.find((entry) => entry.version === '1.0.0')?.paths, [['pkg:npm/a@1.0.0']]);
        assert.deepEqual(shared.find((entry) => entry.version === '2.0.0')?.paths, [['pkg:npm/b@1.0.0']]);
    });

    test('a scoped package keeps its scope in the purl namespace', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { '@s/x': '^1.0.0' } },
            { '@s+x@1.0.0': { manifest: { name: '@s/x', version: '1.0.0' } } },
            { '@s/x': '@s+x@1.0.0' },
        );

        assert.equal(resolve(root)[0]?.purl, 'pkg:npm/%40s/x@1.0.0');
    });

    test('a workspace link is skipped, and store entries only it reaches are not reported', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', web: 'workspace:*' } },
            {
                'a@1.0.0': { manifest: { name: 'a', version: '1.0.0' } },
                // Reachable only from the workspace package, which is another
                // manifest's tree.
                'orphan@1.0.0': { manifest: { name: 'orphan', version: '1.0.0' } },
            },
            { a: 'a@1.0.0' },
        );

        // The workspace package itself lives outside the virtual store.
        writeJson(root, 'packages/web/package.json', { name: 'web', version: '1.0.0' });
        link(`${root}/packages/web`, `${root}/node_modules/web`);

        assert.deepEqual(
            resolve(root).map((entry) => entry.name),
            ['a'],
        );
    });

    test('the pnpm version is unknown when .modules.yaml does not carry it, and the tree still resolves', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            { 'a@1.0.0': { manifest: { name: 'a', version: '1.0.0' } } },
            { a: 'a@1.0.0' },
            'hoistPattern: []\n',
        );

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');
        assert.equal(resolution.outcome === 'resolved' && resolution.packageManager.version, 'unknown');
    });

    test('npm’s hidden lockfile wins when both records exist', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            { 'a@9.9.9': { manifest: { name: 'a', version: '9.9.9' } } },
            { a: 'a@9.9.9' },
        );
        hiddenLockfile(root, { 'node_modules/a': { version: '1.0.0' } });

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');

        if (resolution.outcome === 'resolved') {
            assert.equal(resolution.packageManager.name, 'npm');
            assert.equal(resolution.packages[0]?.version, '1.0.0');
        }
    });

    test('a store entry this reader does not recognise refuses the whole tree loudly', () => {
        const root = pnpmProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            { 'a@1.0.0': { manifest: { name: 'a', version: '1.0.0' } } },
            { a: 'a@1.0.0' },
        );
        // Two real package directories in one instance: a layout this reader
        // does not know. Guessing which one is the package would be worse
        // than reporting nothing.
        writeJson(root, 'node_modules/.pnpm/weird@1.0.0/node_modules/one/package.json', {
            name: 'one',
            version: '1.0.0',
        });
        writeJson(root, 'node_modules/.pnpm/weird@1.0.0/node_modules/two/package.json', {
            name: 'two',
            version: '1.0.0',
        });

        const { resolution, sink } = resolveWith(root);

        assert.equal(resolution.outcome, 'absent');
        assert.match(sink.text(), /refusing to guess/);
    });

    test('pnpm’s hoisted linker resolves through the manifest walk, still named pnpm', () => {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer', dependencies: { a: '^1.0.0' } });
        write(root, 'node_modules/.modules.yaml', 'nodeLinker: hoisted\npackageManager: pnpm@9.12.0\n');
        writeJson(root, 'node_modules/a/package.json', { name: 'a', version: '1.0.0' });

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');

        if (resolution.outcome === 'resolved') {
            assert.deepEqual(resolution.packageManager, {
                name: 'pnpm',
                version: '9.12.0',
                lockfileName: 'pnpm-lock.yaml',
            });
            assert.equal(resolution.packages[0]?.name, 'a');
        }
    });
});

describe('Flat node_modules layouts (the manifest walk)', () => {
    /** A real flat tree: package dirs with their own installed manifests. */
    function flatProject(manifest: unknown, files: Record<string, unknown>): string {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', manifest);

        for (const [path, contents] of Object.entries(files)) {
            if (typeof contents === 'string') {
                write(root, path, contents);
            } else {
                writeJson(root, path, contents);
            }
        }

        return root;
    }

    test('a PnP file that cannot be read as data is skipped loudly, never executed', () => {
        const root = flatProject({ name: 'consumer' }, { '.pnp.cjs': '/* generated, but no extractable state */' });
        const { resolution, sink } = resolveWith(root);

        assert.deepEqual(resolution, { outcome: 'absent' });
        assert.match(sink.text(), /will not execute \.pnp\.cjs/);
    });

    test('a Yarn Classic tree resolves from the installed manifests: scopes, edges, attribution', () => {
        const root = flatProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' }, devDependencies: { d: '^2.0.0' } },
            {
                'yarn.lock': '# yarn lockfile v1',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } },
                'node_modules/b/package.json': { name: 'b', version: '1.5.0' },
                'node_modules/d/package.json': { name: 'd', version: '2.0.0' },
            },
        );

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');

        if (resolution.outcome !== 'resolved') {
            return;
        }

        assert.deepEqual(resolution.packageManager, { name: 'yarn', version: 'unknown', lockfileName: 'yarn.lock' });
        assert.deepEqual(
            resolution.packages.map((entry) => [entry.name, entry.scope, entry.relationship, entry.depth]),
            [
                ['a', 'runtime', 'direct', 0],
                ['b', 'runtime', 'transitive', 1],
                ['d', 'dev', 'direct', 0],
            ],
        );
        assert.deepEqual(resolution.packages[1]?.paths, [['pkg:npm/a@1.0.0']]);
    });

    test('a nested duplicate resolves to its own parent, deepest node_modules first', () => {
        const root = flatProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', shared: '^1.0.0' } },
            {
                'yarn.lock': '# yarn lockfile v1',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0', dependencies: { shared: '^2.0.0' } },
                'node_modules/shared/package.json': { name: 'shared', version: '1.0.0' },
                'node_modules/a/node_modules/shared/package.json': { name: 'shared', version: '2.0.0' },
            },
        );

        const shared = resolve(root).filter((entry) => entry.name === 'shared');

        assert.deepEqual(shared.map((entry) => entry.version).sort(), ['1.0.0', '2.0.0']);
        assert.deepEqual(shared.find((entry) => entry.version === '2.0.0')?.paths, [['pkg:npm/a@1.0.0']]);
    });

    test('an optionalDependencies edge in an installed manifest makes the subtree optional', () => {
        const root = flatProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'yarn.lock': '# yarn lockfile v1',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0', optionalDependencies: { o: '^1.0.0' } },
                'node_modules/o/package.json': { name: 'o', version: '1.0.0' },
            },
        );

        assert.equal(resolve(root).find((entry) => entry.name === 'o')?.scope, 'optional');
    });

    test('a dependency\u2019s own devDependencies are never walked', () => {
        // `ghost` is hoisted for some other reason; reaching it through a
        // dependency's devDependencies would invent an edge that is not
        // installed.
        const root = flatProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'yarn.lock': '# yarn lockfile v1',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0', devDependencies: { ghost: '^1.0.0' } },
                'node_modules/ghost/package.json': { name: 'ghost', version: '1.0.0' },
            },
        );

        assert.deepEqual(
            resolve(root).map((entry) => entry.name),
            ['a'],
        );
    });

    test('an installed peer dependency is a real edge', () => {
        const root = flatProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', p: '^3.0.0' } },
            {
                'yarn.lock': '# yarn lockfile v1',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0', peerDependencies: { p: '^3.0.0' } },
                'node_modules/p/package.json': { name: 'p', version: '3.0.0' },
            },
        );

        assert.equal(resolve(root).find((entry) => entry.name === 'p')?.depth, 0);
    });

    test('a symlinked entry is the consumer\u2019s own code and is skipped', () => {
        const root = flatProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', web: 'link:./web' } },
            {
                'yarn.lock': '# yarn lockfile v1',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0' },
                'web/package.json': { name: 'web', version: '1.0.0' },
            },
        );
        link(join(root, 'web'), join(root, 'node_modules', 'web'));

        assert.deepEqual(
            resolve(root).map((entry) => entry.name),
            ['a'],
        );
    });

    test('a Yarn Berry node-modules tree is detected by its state markers and pinned version', () => {
        const root = flatProject(
            { name: 'consumer', packageManager: 'yarn@4.5.0', dependencies: { a: '^1.0.0' } },
            {
                'node_modules/.yarn-state.yml': 'version: 1\n',
                '.yarn/install-state.gz': 'binary',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0' },
            },
        );

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');
        assert.equal(resolution.outcome === 'resolved' && resolution.packageManager.name, 'yarn');
        assert.equal(resolution.outcome === 'resolved' && resolution.packageManager.version, '4.5.0');
    });

    test('a Bun tree is detected by its lockfile and resolved the same way', () => {
        const root = flatProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            {
                'bun.lockb': 'binary',
                'node_modules/a/package.json': { name: 'a', version: '1.0.0' },
            },
        );

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');

        if (resolution.outcome === 'resolved') {
            assert.deepEqual(resolution.packageManager, { name: 'bun', version: 'unknown', lockfileName: 'bun.lock' });
            assert.equal(resolution.packages[0]?.name, 'a');
        }
    });

    test('a lockfile with nothing installed is a skip', () => {
        // Nothing on disk to report is an ordinary state.
        const root = flatProject({ name: 'consumer' }, { 'bun.lock': '{}' });

        assert.deepEqual(resolveWith(root).resolution, { outcome: 'absent' });
    });

    test('the npm hidden lockfile outranks a stray yarn.lock', () => {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer', dependencies: { a: '^1.0.0' } });
        write(root, 'yarn.lock', '# yarn lockfile v1');
        hiddenLockfile(root, { 'node_modules/a': { version: '1.0.0' } });

        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');
    });
});

describe('Yarn PnP resolution', () => {
    /**
     * Registry shapes mirror real Yarn 4 output: the top-level entry under
     * [null, [[null, …]]], instances as [reference, {packageDependencies,
     * linkType}], virtual locators for peer variants, null for unmet peers.
     */
    function state(rootDependencies: [string, unknown][], registry: unknown[]): object {
        return {
            __info: [],
            dependencyTreeRoots: [{ name: 'consumer', reference: 'workspace:.' }],
            packageRegistryData: [
                [null, [[null, { packageLocation: './', packageDependencies: rootDependencies, linkType: 'SOFT' }]]],
                [
                    'consumer',
                    [
                        [
                            'workspace:.',
                            { packageLocation: './', packageDependencies: rootDependencies, linkType: 'SOFT' },
                        ],
                    ],
                ],
                ...registry,
            ],
        };
    }

    function instance(reference: string, dependencies: [string, unknown][] = []): unknown[] {
        return [
            reference,
            {
                packageLocation: './.yarn/cache/x.zip/node_modules/x/',
                packageDependencies: dependencies,
                linkType: 'HARD',
            },
        ];
    }

    function pnpProject(manifest: unknown, pnpState: object, inlined = false): string {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', manifest);

        if (inlined) {
            // A booby trap ahead of the literal: if anything ever evaluates
            // this file, it says so on disk and the test fails.
            write(
                root,
                '.pnp.cjs',
                `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'EXECUTED'), '1');\n${inlinePnpState(JSON.stringify(pnpState, null, 2))}`,
            );
        } else {
            writeJson(root, '.pnp.data.json', pnpState);
        }

        return root;
    }

    const MANIFEST = {
        name: 'consumer',
        packageManager: 'yarn@4.5.0',
        dependencies: { a: '^1.0.0' },
        devDependencies: { d: '^2.0.0' },
    };

    const STATE = state(
        [
            ['consumer', 'workspace:.'],
            ['a', 'npm:1.0.0'],
            ['d', 'npm:2.0.0'],
        ],
        [
            [
                'a',
                [
                    instance('npm:1.0.0', [
                        ['a', 'npm:1.0.0'],
                        ['b', 'npm:1.5.0'],
                    ]),
                ],
            ],
            ['b', [instance('npm:1.5.0', [['b', 'npm:1.5.0']])]],
            ['d', [instance('npm:2.0.0', [['d', 'npm:2.0.0']])]],
        ],
    );

    test('it resolves .pnp.data.json: scopes, relationships, attribution and the manager', () => {
        const root = pnpProject(MANIFEST, STATE);
        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');

        if (resolution.outcome !== 'resolved') {
            return;
        }

        assert.deepEqual(resolution.packageManager, { name: 'yarn', version: '4.5.0', lockfileName: 'yarn.lock' });
        assert.deepEqual(
            resolution.packages.map((entry) => [entry.name, entry.scope, entry.relationship, entry.depth]),
            [
                ['a', 'runtime', 'direct', 0],
                ['b', 'runtime', 'transitive', 1],
                ['d', 'dev', 'direct', 0],
            ],
        );
        assert.equal(resolution.packages[0]?.requestedConstraint, '^1.0.0');
        assert.deepEqual(resolution.packages[1]?.paths, [['pkg:npm/a@1.0.0']]);
    });

    test('the inlined .pnp.cjs form resolves identically, and the file is never executed', () => {
        const root = pnpProject(MANIFEST, STATE, true);
        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome, 'resolved');
        assert.equal(
            resolution.outcome === 'resolved' && resolution.packages.map((entry) => entry.name).join(','),
            'a,b,d',
        );
        assert.equal(existsSync(join(root, 'EXECUTED')), false, '.pnp.cjs was evaluated');
    });

    test('virtual instances are peer variants and deduplicate on purl', () => {
        const virtualOne = 'virtual:aaa#npm:3.0.0';
        const virtualTwo = 'virtual:bbb#npm:3.0.0';
        const root = pnpProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', b: '^1.0.0' } },
            state(
                [
                    ['a', 'npm:1.0.0'],
                    ['b', 'npm:1.0.0'],
                ],
                [
                    [
                        'a',
                        [
                            instance('npm:1.0.0', [
                                ['a', 'npm:1.0.0'],
                                ['peered', virtualOne],
                            ]),
                        ],
                    ],
                    [
                        'b',
                        [
                            instance('npm:1.0.0', [
                                ['b', 'npm:1.0.0'],
                                ['peered', virtualTwo],
                            ]),
                        ],
                    ],
                    [
                        'peered',
                        [
                            instance(virtualOne, [
                                ['peered', virtualOne],
                                ['supports-color', null],
                            ]),
                            instance(virtualTwo, [
                                ['peered', virtualTwo],
                                ['supports-color', null],
                            ]),
                        ],
                    ],
                ],
            ),
        );

        const peered = resolve(root).filter((entry) => entry.name === 'peered');

        assert.equal(peered.length, 1);
        assert.equal(peered[0]?.version, '3.0.0');
    });

    test('workspace locators and unknown protocols are skipped, chains dropped whole', () => {
        const root = pnpProject(
            { name: 'consumer', dependencies: { a: '^1.0.0', web: 'workspace:*', tool: 'portal:./tool' } },
            state(
                [
                    ['a', 'npm:1.0.0'],
                    ['web', 'workspace:packages/web'],
                    ['tool', 'portal:./tool::locator=consumer'],
                ],
                [
                    ['a', [instance('npm:1.0.0', [['a', 'npm:1.0.0']])]],
                    ['web', [instance('workspace:packages/web', [['under', 'npm:1.0.0']])]],
                    ['tool', [instance('portal:./tool::locator=consumer', [['under', 'npm:1.0.0']])]],
                    ['under', [instance('npm:1.0.0', [['under', 'npm:1.0.0']])]],
                ],
            ),
        );

        // Only what the manifest reaches through readable locators: `under`
        // sits behind a workspace and a portal, so it is not this manifest's
        // to report, and no parent is invented for it.
        assert.deepEqual(
            resolve(root).map((entry) => entry.name),
            ['a'],
        );
    });

    test('a patch: reference carries the patched package’s version', () => {
        // Yarn patches TypeScript by default, so this shape is routine.
        const patched = 'patch:typescript@npm%3A5.6.3#optional!builtin<compat/typescript>';
        const root = pnpProject(
            { name: 'consumer', devDependencies: { typescript: '^5.6.0' } },
            state([['typescript', patched]], [['typescript', [instance(patched, [['typescript', patched]])]]]),
        );

        const entry = resolve(root)[0];

        assert.equal(entry?.name, 'typescript');
        assert.equal(entry?.version, '5.6.3');
        assert.equal(entry?.scope, 'dev');
    });

    test('unparseable PnP state is a loud skip that names the way out', () => {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer' });
        writeJson(root, '.pnp.data.json', { packageRegistryData: 'not an array' });

        const { resolution, sink } = resolveWith(root);

        assert.deepEqual(resolution, { outcome: 'absent' });
        assert.match(sink.text(), /pnpEnableInlining/);
    });

    test('the yarn version is unknown without a packageManager pin, and the tree still resolves', () => {
        const root = pnpProject(
            { name: 'consumer', dependencies: { a: '^1.0.0' } },
            state([['a', 'npm:1.0.0']], [['a', [instance('npm:1.0.0')]]]),
        );
        const { resolution } = resolveWith(root);

        assert.equal(resolution.outcome === 'resolved' && resolution.packageManager.version, 'unknown');
    });
});

describe('PnP reference parsing', () => {
    test('the whitelist, and only the whitelist, yields versions', () => {
        assert.equal(versionOf('npm:1.2.3'), '1.2.3');
        assert.equal(versionOf('npm:1.2.3::__archiveUrl=https%3A%2F%2Fexample.com'), '1.2.3');
        assert.equal(versionOf('virtual:abc123#npm:4.4.3'), '4.4.3');
        assert.equal(versionOf('patch:typescript@npm%3A5.6.3#optional!builtin<compat/typescript>'), '5.6.3');
        assert.equal(versionOf('workspace:.'), null);
        assert.equal(versionOf('workspace:packages/web'), null);
        assert.equal(versionOf('portal:./tool'), null);
        assert.equal(versionOf('link:./somewhere'), null);
        assert.equal(versionOf('exec:./gen.js'), null);
        assert.equal(versionOf('npm:'), null);
        assert.equal(versionOf('virtual:abc123'), null);
        assert.equal(versionOf('patch:typescript@workspace%3A.#./local.patch'), null);
    });
});

describe('Inlined PnP state extraction', () => {
    test('it round-trips the exact escapes real Yarn output uses', () => {
        // The backslash-newline pairs are line *continuations*: they decode to
        // nothing, so the extracted text is the JSON minus its newlines --
        // insignificant whitespace, byte-identical semantics.
        const value = { packageRegistryData: [], note: "it's a backslash: \\ and a regex \\/" };
        const extracted = extractInlinedState(inlinePnpState(JSON.stringify(value, null, 2)));

        assert.notEqual(extracted, null);
        assert.doesNotMatch(extracted as string, /\n/);
        assert.deepEqual(JSON.parse(extracted as string), value);
    });

    test('anything outside the known shape is null, never a guess', () => {
        assert.equal(extractInlinedState('module.exports = {};'), null, 'missing marker');
        assert.equal(extractInlinedState('const RAW_RUNTIME_STATE = 42;'), null, 'no literal');
        assert.equal(extractInlinedState("const RAW_RUNTIME_STATE =\n'unterminated"), null, 'unterminated literal');
        assert.equal(extractInlinedState("const RAW_RUNTIME_STATE =\n'bad \\t escape'"), null, 'unknown escape');
    });
});
