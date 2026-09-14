import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Attribution, attributeWalk, type InstalledNode, type InstalledTree } from '../graph.js';
import type { Logger } from '../logger.js';
import { names, propagateClasses, readManifest, type ScopeEdge, scopeOfClasses, seedClasses } from './scopes.js';

/**
 * The installed dependency graph of a pnpm tree, read from the virtual store.
 *
 * pnpm's isolated linker records what it installed **in the filesystem
 * itself**: every package@version instance is a real directory under
 * `node_modules/.pnpm/<key>/node_modules/<name>`, carrying its own installed
 * `package.json`, and the symlinks beside it *are* the edge set -- one link
 * per dependency, pointing at the instance that satisfies it. That is the
 * same shape the npm reader gets from the hidden lockfile's per-entry
 * `dependencies` maps, so the identity and the edges come from what the
 * installer wrote, in plain JSON and symlinks, with no YAML parser anywhere.
 *
 * The one thing read out of `.modules.yaml` is the `packageManager` scalar,
 * with an anchored line match -- for the version the payload carries, never
 * for the tree. A store layout this reader does not recognise is refused
 * loudly; it never guesses. See ADR-0044.
 *
 * **Nodes are keyed by virtual-store key**, e.g. `react-dom@18.2.0(react@18.2.0)`
 * -- pnpm installs one instance per peer-dependency combination, and two
 * instances of the same version are genuinely different installed copies,
 * exactly as npm's nested duplicates are. Store keys are never parsed for
 * identity; the instance's own package.json is.
 *
 * pnpm keeps no per-node dev/optional flags in its installed state, so scopes
 * are computed the way npm itself computes its flags: from which of the root
 * manifest's sections reach a package, propagated over the on-disk edges. A
 * store entry nothing in this manifest reaches -- another workspace package's
 * dependency, say -- is not part of this Manifest's tree and is not reported.
 */

interface Instance {
    readonly name: string;
    readonly version: string;
    /** In link-name order, targets that resolved inside the store. */
    readonly edges: readonly ScopeEdge[];
}

export type PnpmRead =
    | { outcome: 'tree'; tree: InstalledTree; version: string }
    /** Recognisably pnpm, deliberately not resolved. Already reported loudly. */
    | { outcome: 'refused' }
    /** A layout this reader does not understand. Already reported loudly. */
    | { outcome: 'unreadable' }
    | { outcome: 'absent' };

export function readPnpmTree(projectRoot: string, logger: Logger): PnpmRead {
    const modulesDir = join(projectRoot, 'node_modules');
    const modulesManifest = join(modulesDir, '.modules.yaml');
    const store = join(modulesDir, '.pnpm');

    const hasManifest = isFile(modulesManifest);
    const hasStore = isDirectory(store);

    if (!hasManifest && !hasStore) {
        return { outcome: 'absent' };
    }

    if (!hasStore) {
        // nodeLinker: hoisted, or a relocated virtual store. Either way the
        // per-package record this reader needs is not where pnpm's default
        // layout puts it, and a generic walk would fabricate the scopes.
        logger.warn(
            'pnpm installed this tree without its isolated layout (node_modules/.pnpm is missing), ' +
                'so there is no per-package record to read. Use the CI step or the HTTP contract instead.',
        );

        return { outcome: 'refused' };
    }

    const instances = readStore(store, logger);

    if (instances === null) {
        return { outcome: 'unreadable' };
    }

    const rootIds = topLevelIds(modulesDir, store);
    const reached = propagateClasses(
        seedClasses(projectRoot, rootIds),
        new Set(instances.keys()),
        new Map([...instances].map(([key, instance]) => [key, instance.edges])),
    );

    const nodes = new Map<string, InstalledNode>();
    let unreached = 0;

    for (const key of [...instances.keys()].sort()) {
        const classes = reached.get(key);

        if (classes === undefined) {
            unreached += 1;

            continue;
        }

        const instance = instances.get(key) as Instance;
        nodes.set(key, { path: key, name: instance.name, version: instance.version, scope: scopeOfClasses(classes) });
    }

    if (unreached > 0) {
        logger.debug(
            `${unreached} pnpm virtual-store entries are not reachable from this manifest ` +
                "(another workspace package's dependencies, or orphans) and were not reported.",
        );
    }

    const edges = new Map<string, string[]>();

    for (const [key, instance] of instances) {
        if (nodes.has(key)) {
            edges.set(
                key,
                instance.edges.map((edge) => edge.target).filter((target) => nodes.has(target)),
            );
        }
    }

    return {
        outcome: 'tree',
        tree: new PnpmTree(nodes, edges, rootIds),
        version: pnpmVersion(modulesManifest),
    };
}

class PnpmTree implements InstalledTree {
    constructor(
        private readonly nodes: Map<string, InstalledNode>,
        /** Store key => the store keys it links, already resolved. */
        private readonly edges: Map<string, string[]>,
        /** Top-level installed name => store key. */
        private readonly rootIds: Map<string, string>,
    ) {}

    installed(): Map<string, InstalledNode> {
        return this.nodes;
    }

    attribute(roots: readonly string[]): Map<string, Attribution> {
        const ids: string[] = [];

        for (const root of roots) {
            const id = this.rootIds.get(root);

            if (id !== undefined && this.nodes.has(id)) {
                ids.push(id);
            }
        }

        return attributeWalk(ids, (parent) => this.edges.get(parent) ?? []);
    }
}

/**
 * Null when the store holds a construct this reader does not recognise --
 * refusing the whole tree loudly, because a partially guessed inventory is
 * worse than an admitted gap.
 */
function readStore(store: string, logger: Logger): Map<string, Instance> | null {
    let storeReal: string;
    let keys: string[];

    try {
        storeReal = realpathSync(store);
        keys = readdirSync(store, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
            .map((entry) => entry.name)
            .sort();
    } catch {
        logger.warn('node_modules/.pnpm is not readable; skipping.');

        return null;
    }

    const instances = new Map<string, Instance>();

    for (const key of keys) {
        const listed = listPackageEntries(join(store, key, 'node_modules'));

        if (listed === null) {
            logger.warn(
                `the pnpm virtual store entry [${key}] has no readable node_modules directory; ` +
                    'refusing to guess at this tree.',
            );

            return null;
        }

        // The instance's own package is the one real directory; every symlink
        // beside it is an edge. More than one real directory is a layout this
        // reader does not know.
        const selves = listed.filter((entry) => !entry.isLink);
        const self = selves[0];

        if (self === undefined || selves.length !== 1) {
            logger.warn(
                `the pnpm virtual store entry [${key}] does not hold exactly one package directory; ` +
                    'refusing to guess at this tree.',
            );

            return null;
        }

        const manifest = readManifest(join(self.path, 'package.json'));

        if (manifest === null) {
            logger.warn(
                `the pnpm virtual store entry [${key}] has no readable package.json; ` +
                    'refusing to guess at this tree.',
            );

            return null;
        }

        const name = manifest.name;
        const version = manifest.version;

        // Metapackages and anything without a concrete version have nothing to
        // match against; chains through them are dropped whole, never shortened.
        if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
            continue;
        }

        const optionalNames = new Set(names(manifest.optionalDependencies));
        const edges: ScopeEdge[] = [];

        for (const entry of listed) {
            if (!entry.isLink) {
                continue;
            }

            const target = resolveIntoStore(entry.path, storeReal);

            // A link leading outside the store is a workspace package -- the
            // consumer's own code, not a dependency of this tree.
            if (target !== null) {
                edges.push({ target, optional: optionalNames.has(entry.name) });
            }
        }

        instances.set(key, { name, version, edges });
    }

    return instances;
}

/**
 * The packages installed in one node_modules directory: real directories and
 * symlinks, with scopes flattened to `@scope/name`. Dot-entries are skipped --
 * `.bin`, `.modules.yaml`, `.pnpm` -- because a package name cannot begin
 * with a dot. Sorted by name, so every walk over a tree is deterministic.
 */
function listPackageEntries(dir: string): { name: string; path: string; isLink: boolean }[] | null {
    let dirents: Dirent[];

    try {
        dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }

    const entries: { name: string; path: string; isLink: boolean }[] = [];

    for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) {
            continue;
        }

        if (dirent.isSymbolicLink()) {
            entries.push({ name: dirent.name, path: join(dir, dirent.name), isLink: true });

            continue;
        }

        if (!dirent.isDirectory()) {
            continue;
        }

        if (dirent.name.startsWith('@')) {
            let scoped: Dirent[];

            try {
                scoped = readdirSync(join(dir, dirent.name), { withFileTypes: true });
            } catch {
                continue;
            }

            for (const sub of scoped) {
                if (sub.name.startsWith('.')) {
                    continue;
                }

                if (sub.isSymbolicLink() || sub.isDirectory()) {
                    entries.push({
                        name: `${dirent.name}/${sub.name}`,
                        path: join(dir, dirent.name, sub.name),
                        isLink: sub.isSymbolicLink(),
                    });
                }
            }

            continue;
        }

        entries.push({ name: dirent.name, path: join(dir, dirent.name), isLink: false });
    }

    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Follows a link and answers which store instance it lands in, or null when
 * it leads anywhere else -- a dangling link, or a workspace package.
 */
function resolveIntoStore(linkPath: string, storeReal: string): string | null {
    let resolved: string;

    try {
        resolved = realpathSync(linkPath);
    } catch {
        return null;
    }

    const parts = relative(storeReal, resolved).split(sep);
    const key = parts[0];

    if (key === undefined || key === '' || key === '..' || parts[1] !== 'node_modules') {
        return null;
    }

    return key;
}

/** Top-level installed name => store key, read from the root symlink farm. */
function topLevelIds(modulesDir: string, store: string): Map<string, string> {
    const ids = new Map<string, string>();
    const listed = listPackageEntries(modulesDir);

    if (listed === null) {
        return ids;
    }

    let storeReal: string;

    try {
        storeReal = realpathSync(store);
    } catch {
        return ids;
    }

    for (const entry of listed) {
        if (!entry.isLink) {
            continue;
        }

        const key = resolveIntoStore(entry.path, storeReal);

        if (key !== null) {
            ids.set(entry.name, key);
        }
    }

    return ids;
}

/**
 * The single scalar this client reads out of `.modules.yaml`: the version the
 * payload carries. An absent or unrecognisable line is an admitted `unknown`,
 * never a guess -- and never a reason to refuse a tree the store itself
 * describes perfectly well.
 */
function pnpmVersion(modulesManifest: string): string {
    try {
        const matched = /^packageManager: ["']?pnpm@([^"'\s]+)["']?\s*$/m.exec(readFileSync(modulesManifest, 'utf8'));

        return matched?.[1] ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}
