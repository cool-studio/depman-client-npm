import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { purl, Resolver } from '../src/resolver.js';
import { cleanup, hiddenLockfile, link, pnpmTree, recordingLogger, workspace, write, writeJson } from './helpers.js';

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

    test('pnpm without its virtual store is refused loudly by name', () => {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer' });
        write(root, 'node_modules/.modules.yaml', 'nodeLinker: hoisted\npackageManager: pnpm@9.12.0\n');

        const { resolution, sink } = resolveWith(root);

        assert.deepEqual(resolution, { outcome: 'refused', manager: 'pnpm' });
        assert.match(sink.text(), /pnpm/);
    });
});

describe('Refused package managers', () => {
    function refusedProject(files: Record<string, string>): {
        resolution: ReturnType<Resolver['resolve']>;
        sink: { text(): string };
    } {
        const root = workspace();
        roots.push(root);
        writeJson(root, 'package.json', { name: 'consumer' });

        for (const [path, contents] of Object.entries(files)) {
            write(root, path, contents);
        }

        return resolveWith(root);
    }

    test('Yarn Plug’n’Play is refused by name, because reading .pnp.cjs means executing it', () => {
        const { resolution, sink } = refusedProject({ '.pnp.cjs': '/* generated */' });

        assert.deepEqual(resolution, { outcome: 'refused', manager: 'yarn' });
        assert.match(sink.text(), /Plug'n'Play/);
    });

    test('a Yarn node_modules tree is refused by name', () => {
        const { resolution, sink } = refusedProject({
            'yarn.lock': '# yarn lockfile v1',
            'node_modules/a/package.json': '{"name":"a","version":"1.0.0"}',
        });

        assert.deepEqual(resolution, { outcome: 'refused', manager: 'yarn' });
        assert.match(sink.text(), /Yarn/);
    });

    test('a Yarn Berry install-state is refused even without a lockfile beside it', () => {
        const { resolution } = refusedProject({ '.yarn/install-state.gz': 'binary' });

        assert.deepEqual(resolution, { outcome: 'refused', manager: 'yarn' });
    });

    test('Bun is refused by name', () => {
        const { resolution, sink } = refusedProject({
            'bun.lockb': 'binary',
            'node_modules/a/package.json': '{"name":"a","version":"1.0.0"}',
        });

        assert.deepEqual(resolution, { outcome: 'refused', manager: 'bun' });
        assert.match(sink.text(), /Bun/);
    });

    test('a lockfile with nothing installed is a skip, not a refusal', () => {
        // Nothing on disk to report is an ordinary state; the refusal is for
        // trees that exist and cannot be read honestly.
        const { resolution } = refusedProject({ 'bun.lock': '{}' });

        assert.deepEqual(resolution, { outcome: 'absent' });
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
