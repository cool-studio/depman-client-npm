import { readFileSync, statSync } from 'node:fs';
import type { Logger } from './logger.js';

/**
 * The installed dependency graph, read from node_modules/.package-lock.json.
 *
 * That file is npm's **hidden lockfile**: it is written by the installer after
 * an install, and it describes what is on disk. It is not the project's
 * `package-lock.json`, which is an intention and which
 * docs/ingest-clients.md section 5 forbids parsing by hand. The two disagree
 * exactly when it matters -- after `npm install --omit=dev`, after a partial
 * install, and whenever a lockfile is committed but not applied.
 *
 * Attribution answers "which of my dependencies pulled this in?", so the walk
 * starts at the root manifest's own dependencies and proceeds breadth-first.
 * The first layer is depth 0, and a package's ancestry chain begins with the
 * direct dependency the reader can actually edit.
 *
 * **Nodes are keyed by install path, not by name.** npm installs the same
 * package name at several depths with different versions, and `node_modules/a`
 * and `node_modules/b/node_modules/a` are genuinely different installed
 * packages. Keying by name -- which is right for Composer, where a name has one
 * version -- would silently attribute a nested duplicate to the wrong parent.
 */

/** Nobody acts on a chain this long, and carrying it is payload weight with no reader. */
const MAX_CHAIN = 16;

/** The server stores at most three (`report_dependencies.paths`). */
const MAX_PATHS = 3;

/**
 * Candidates held before ranking. A diamond-shaped graph can reach one package
 * by hundreds of equally short routes; this bounds the work without deciding
 * which three survive.
 */
const MAX_CANDIDATES = 12;

export type Scope = 'runtime' | 'dev' | 'optional';

export interface InstalledNode {
    /**
     * The reader's stable identity for one installed copy: the hidden
     * lockfile's own key for npm (`node_modules/a/node_modules/b`), the
     * virtual-store key for pnpm.
     */
    readonly path: string;
    /** The path split at each `node_modules/`, e.g. `['a', 'b']`. npm only. */
    readonly segments?: readonly string[];
    readonly name: string;
    readonly version: string;
    readonly scope: Scope;
}

export interface Attribution {
    readonly depth: number;
    /** Ancestry chains of install paths, root-first, excluding the package itself. */
    readonly paths: string[][];
}

/**
 * What every per-manager reader hands the Resolver: the installed node set,
 * and attribution from the root manifest's own dependency names.
 */
export interface InstalledTree {
    installed(): Map<string, InstalledNode>;
    attribute(roots: readonly string[]): Map<string, Attribution>;
}

export class Graph implements InstalledTree {
    private constructor(
        private readonly nodes: Map<string, InstalledNode>,
        /** Install path => the runtime dependency names it declares. */
        private readonly edges: Map<string, string[]>,
    ) {}

    installed(): Map<string, InstalledNode> {
        return this.nodes;
    }

    /**
     * Null when the file is missing or unreadable -- the caller reports nothing
     * rather than falling back to the project lockfile, which is not what is
     * installed.
     */
    static read(path: string, logger: Logger): Graph | null {
        let present = false;

        try {
            present = statSync(path).isFile();
        } catch {
            present = false;
        }

        if (!present) {
            logger.debug('node_modules/.package-lock.json not found; nothing to report.');

            return null;
        }

        let decoded: unknown;

        try {
            decoded = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
            logger.warn('node_modules/.package-lock.json is not valid JSON; skipping.');

            return null;
        }

        if (!isRecord(decoded) || !isRecord(decoded.packages)) {
            logger.warn('node_modules/.package-lock.json has an unexpected shape; skipping.');

            return null;
        }

        const nodes = new Map<string, InstalledNode>();
        const edges = new Map<string, string[]>();

        for (const [key, raw] of Object.entries(decoded.packages)) {
            if (!isRecord(raw)) {
                continue;
            }

            // A workspace link has no content of its own; the real package sits
            // outside node_modules under its workspace directory. Skipping it
            // costs the chains that pass through it, which is the honest
            // outcome -- a shortened chain would claim a parent that is not the
            // parent. Workspaces are a follow-on step.
            if (raw.link === true) {
                continue;
            }

            const segments = segmentsOf(key);

            if (segments === null) {
                continue;
            }

            const name = segments[segments.length - 1];
            const version = raw.version;

            // Metapackages, links and anything the installer could not place
            // have nothing to match against.
            if (name === undefined || typeof version !== 'string' || version === '') {
                continue;
            }

            nodes.set(key, { path: key, segments, name, version, scope: scopeOf(raw) });

            // Runtime edges only. A dependency's own devDependencies are not
            // installed, and walking them would invent edges that are not on
            // disk. optionalDependencies are installed, so they are edges.
            edges.set(key, [...names(raw.dependencies), ...names(raw.optionalDependencies)].sort());
        }

        return new Graph(nodes, edges);
    }

    /**
     * Node's own resolution algorithm: a dependency of `node_modules/a/node_modules/b`
     * resolves to the deepest `node_modules` directory that holds it, walking
     * outwards to the project root. Getting this wrong is how a nested
     * duplicate gets attributed to the wrong parent.
     */
    resolve(from: readonly string[], name: string): string | null {
        for (let depth = from.length; depth >= 0; depth--) {
            const candidate = pathOf([...from.slice(0, depth), name]);

            if (this.nodes.has(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Breadth-first from the root's dependencies.
     *
     * @param roots The names the root manifest depends on.
     * @returns Keyed by install path.
     */
    attribute(roots: readonly string[]): Map<string, Attribution> {
        const rootPaths: string[] = [];

        for (const root of roots) {
            const path = this.resolve([], root);

            if (path !== null) {
                rootPaths.push(path);
            }
        }

        return attributeWalk(rootPaths, (parent) => this.childrenOf(parent));
    }

    /** A parent's edge names become install paths, resolved from its own depth. */
    private childrenOf(parent: string): string[] {
        const segments = this.nodes.get(parent)?.segments ?? [];
        const children: string[] = [];

        for (const required of this.edges.get(parent) ?? []) {
            const child = this.resolve(segments, required);

            if (child !== null) {
                children.push(child);
            }
        }

        return children;
    }
}

/**
 * Breadth-first attribution over a resolved edge set.
 *
 * Shared by every per-manager reader, because the walk is the subtle part of
 * attribution -- depth, shortest chains, the cycle guard, determinism -- and
 * duplicating it per format is how the readers would drift. A reader supplies
 * node identity and edges; this decides depth and ancestry.
 */
export function attributeWalk(
    roots: readonly string[],
    childrenOf: (parent: string) => readonly string[],
): Map<string, Attribution> {
    const depth = new Map<string, number>();
    /** Ancestry, root-first, excluding the package itself. */
    const chains = new Map<string, string[][]>();
    let frontier: string[] = [];

    for (const root of roots) {
        if (depth.has(root)) {
            continue;
        }

        depth.set(root, 0);
        // A direct dependency has an empty ancestry, which is what makes its
        // children's chains start with the direct dependency itself.
        chains.set(root, [[]]);
        frontier.push(root);
    }

    frontier.sort();

    while (frontier.length > 0) {
        const next: string[] = [];

        for (const parent of frontier) {
            const parentDepth = depth.get(parent) ?? 0;
            const parentChains = chains.get(parent) ?? [];

            for (const child of childrenOf(parent)) {
                if (child === parent) {
                    continue;
                }

                if (!depth.has(child)) {
                    depth.set(child, parentDepth + 1);
                    chains.set(child, []);
                    next.push(child);
                }

                // An edge back to an equal or shallower package is a cycle,
                // or a longer way round to something already attributed.
                // Neither adds a path, and an unguarded walk does not
                // return.
                if (depth.get(child) !== parentDepth + 1) {
                    continue;
                }

                const childChains = chains.get(child) ?? [];

                for (const chain of parentChains) {
                    if (childChains.length >= MAX_CANDIDATES) {
                        break;
                    }

                    const extended = [...chain, parent];

                    if (extended.length <= MAX_CHAIN) {
                        childChains.push(extended);
                    }
                }
            }
        }

        next.sort();
        frontier = next;
    }

    const attributed = new Map<string, Attribution>();

    for (const [path, distance] of depth) {
        attributed.set(path, {
            depth: distance,
            paths: distance === 0 ? [] : rank(chains.get(path) ?? []),
        });
    }

    return attributed;
}

/**
 * Same tree, same bytes. Every chain here is already a shortest one, so the
 * length comparison only decides ties that MAX_CHAIN truncation can leave.
 */
function rank(chains: string[][]): string[][] {
    return [...chains].sort((a, b) => a.length - b.length || compare(a.join('\n'), b.join('\n'))).slice(0, MAX_PATHS);
}

/**
 * `node_modules/a/node_modules/@scope/b` becomes `['a', '@scope/b']`.
 *
 * Null for a key that is not inside node_modules at all -- the root entry `""`
 * and workspace directories such as `packages/web`.
 */
export function segmentsOf(key: string): string[] | null {
    if (!key.startsWith('node_modules/')) {
        return null;
    }

    const segments = key.slice('node_modules/'.length).split('/node_modules/');

    return segments.every((segment) => segment !== '') ? segments : null;
}

export function pathOf(segments: readonly string[]): string {
    return `node_modules/${segments.join('/node_modules/')}`;
}

/**
 * npm flags a package `dev` when only devDependencies reach it, `optional` when
 * only optionalDependencies do, and `devOptional` when both do. `devOptional`
 * maps to optional because an optional dependency of a production dependency is
 * installed in production, and the server's precedence puts optional above dev
 * -- reporting the more privileged of the two is the conservative reading.
 */
function scopeOf(raw: Record<string, unknown>): Scope {
    if (raw.optional === true) {
        return 'optional';
    }

    if (raw.devOptional === true) {
        return 'optional';
    }

    return raw.dev === true ? 'dev' : 'runtime';
}

function names(links: unknown): string[] {
    return isRecord(links) ? Object.keys(links) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Byte-wise, so ordering never depends on a locale. */
function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
