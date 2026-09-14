import { lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Attribution, attributeWalk, type InstalledNode, type InstalledTree } from '../graph.js';
import type { Logger } from '../logger.js';
import { names, propagateClasses, readManifest, type ScopeEdge, scopeOfClasses, seedClasses } from './scopes.js';

/**
 * The installed dependency graph of any flat `node_modules` layout, read
 * from the installed packages' own manifests.
 *
 * Yarn (Classic, and Berry's node-modules linker), Bun and pnpm's hoisted
 * linker all produce the same shape: real package directories, hoisted and
 * nested by the npm layout rules, with **no per-entry metadata file**. What
 * they do leave is section 5's raw material -- every installed package's own
 * `package.json`, which is the fact on disk: identity, version, and the
 * `dependencies` / `optionalDependencies` / `peerDependencies` maps that are
 * the edge set. Edges resolve by node's own algorithm (deepest `node_modules`
 * first, walking out to the project root), exactly as the npm reader resolves
 * the hidden lockfile's edges -- so what is walked here is what `require()`
 * would actually load.
 *
 * This is deliberately *not* the "generic node_modules walk" ADR-0038
 * rejected: that walk enumerated directories and lost scopes and edges.
 * This one reads each installed manifest, the same technique the pnpm reader
 * uses on the virtual store, and computes dev/optional the way npm itself
 * does -- path classes from the root manifest's sections, propagated over
 * the on-disk edges. ADR-0046 records the decision.
 *
 * **Nodes are keyed by install path**, npm-style: `node_modules/a` and
 * `node_modules/b/node_modules/a` are different installed copies. A
 * dependency's own devDependencies are never walked (they are not installed,
 * and a name could coincidentally resolve to a package hoisted for another
 * reason -- an invented edge). Symlinked entries are workspace links or
 * `npm link`s -- the consumer's own code -- and are skipped, with chains
 * through them dropped whole. Only what the root manifest reaches is
 * reported; the walk never guesses at what an unreachable directory is for.
 */

/** Discovered during the walk; becomes an InstalledNode once scopes exist. */
interface Visited {
    readonly segments: readonly string[];
    readonly name: string;
    readonly version: string;
    /** Sorted (name, optional) specs from this package's own manifest. */
    readonly edgeSpecs: readonly { name: string; optional: boolean }[];
}

export function readManifestWalkTree(projectRoot: string, logger: Logger): InstalledTree {
    const visited = new Map<string, Visited | null>();
    const resolvedEdges = new Map<string, ScopeEdge[]>();
    const rootIds = new Map<string, string>();

    const rootManifest = readManifest(join(projectRoot, 'package.json'));
    const queue: string[] = [];

    const visit = (segments: readonly string[]): string | null => {
        const path = installPath(segments);
        const known = visited.get(path);

        if (known !== undefined) {
            return known === null ? null : path;
        }

        const manifest = readManifest(join(projectRoot, path, 'package.json'));
        const version = manifest?.version;

        // A directory without a concrete version is a metapackage or a broken
        // install: nothing to match, so no node, and chains through it drop.
        if (manifest === null || typeof version !== 'string' || version === '') {
            visited.set(path, null);

            return null;
        }

        const name =
            typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : segments[segments.length - 1];

        visited.set(path, {
            segments,
            name: name as string,
            version,
            edgeSpecs: edgeSpecsOf(manifest),
        });
        queue.push(path);

        return path;
    };

    // Seed from the root manifest's sections -- the only edges the root
    // contributes. peerDependencies included: modern managers install them.
    for (const section of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of names(rootManifest?.[section])) {
            if (rootIds.has(name)) {
                continue;
            }

            const target = resolveOnDisk(projectRoot, [], name);

            if (target !== null && visit(target) !== null) {
                rootIds.set(name, installPath(target));
            }
        }
    }

    for (let index = 0; index < queue.length; index++) {
        const path = queue[index] as string;
        const node = visited.get(path) as Visited;
        const edges: ScopeEdge[] = [];

        for (const spec of node.edgeSpecs) {
            const target = resolveOnDisk(projectRoot, node.segments, spec.name);

            if (target === null) {
                continue;
            }

            const targetPath = visit(target);

            if (targetPath !== null && targetPath !== path) {
                edges.push({ target: targetPath, optional: spec.optional });
            }
        }

        resolvedEdges.set(path, edges);
    }

    const reached = propagateClasses(seedClasses(projectRoot, rootIds), new Set(resolvedEdges.keys()), resolvedEdges);

    const nodes = new Map<string, InstalledNode>();

    for (const path of [...resolvedEdges.keys()].sort()) {
        const classes = reached.get(path);
        const node = visited.get(path);

        if (classes !== undefined && node !== null && node !== undefined) {
            nodes.set(path, { path, name: node.name, version: node.version, scope: scopeOfClasses(classes) });
        }
    }

    const unreached = resolvedEdges.size - nodes.size;

    if (unreached > 0) {
        logger.debug(`${unreached} installed packages are not reachable from this manifest and were not reported.`);
    }

    const edges = new Map<string, string[]>();

    for (const [path, targets] of resolvedEdges) {
        if (nodes.has(path)) {
            edges.set(
                path,
                targets.map((edge) => edge.target).filter((target) => nodes.has(target)),
            );
        }
    }

    return new ManifestWalkTree(nodes, edges, rootIds);
}

class ManifestWalkTree implements InstalledTree {
    constructor(
        private readonly nodes: Map<string, InstalledNode>,
        private readonly edges: Map<string, string[]>,
        /** Root-manifest dependency name => install path. */
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
 * Node's own resolution algorithm over the real filesystem: the deepest
 * `node_modules` directory that holds a real (non-symlink) package directory
 * with a readable manifest wins, walking outwards to the project root.
 */
function resolveOnDisk(projectRoot: string, from: readonly string[], name: string): string[] | null {
    for (let depth = from.length; depth >= 0; depth--) {
        const segments = [...from.slice(0, depth), name];
        const path = join(projectRoot, installPath(segments));

        if (isRealDirectory(path) && isFile(join(path, 'package.json'))) {
            return segments;
        }
    }

    return null;
}

/**
 * Runtime edges only: a package's own devDependencies are not installed, and
 * a name in them could coincidentally resolve to something hoisted for
 * another reason -- an invented edge. Installed peers are real edges; where
 * a manager does not install them (Yarn Classic), resolution simply fails
 * and the spec is dropped. Sorted, so every walk is deterministic.
 */
function edgeSpecsOf(manifest: Record<string, unknown>): { name: string; optional: boolean }[] {
    const optionalNames = new Set(names(manifest.optionalDependencies));
    const specs = new Map<string, boolean>();

    for (const name of [...names(manifest.dependencies), ...names(manifest.peerDependencies)]) {
        specs.set(name, specs.get(name) ?? false);
    }

    for (const name of optionalNames) {
        if (!specs.has(name)) {
            specs.set(name, true);
        }
    }

    return [...specs.entries()]
        .map(([name, optional]) => ({ name, optional }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function installPath(segments: readonly string[]): string {
    return `node_modules/${segments.join('/node_modules/')}`;
}

/** A symlink is a workspace link or an `npm link` -- the consumer's own code. */
function isRealDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}
