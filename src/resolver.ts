import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Graph, type InstalledTree, type Scope } from './graph.js';
import type { Logger } from './logger.js';
import { readManifestWalkTree } from './resolvers/manifest-walk.js';
import { readPnpmTree } from './resolvers/pnpm.js';
import { pinnedManagerVersion } from './resolvers/scopes.js';
import { readYarnPnpTree } from './resolvers/yarn-pnp.js';

/**
 * Reads the installed dependency tree, dispatching on which package manager
 * actually installed it.
 *
 * Four managers install the npm ecosystem, and they do not share
 * installed-state metadata. Detection is from what is on disk -- never from
 * `npm_config_user_agent`, which is absent when the hook runs outside an
 * install and lies when one manager shells out to another:
 *
 *   - **npm**: `node_modules/.package-lock.json`, the hidden lockfile the
 *     installer writes to describe what it put on disk. Not the project's
 *     `package-lock.json`, which is an intention. It carries `dev`, `optional`
 *     and `devOptional` per package, and the per-entry `dependencies` maps
 *     attribution walks. See Graph.
 *   - **pnpm** (isolated linker): the virtual store under `node_modules/.pnpm`,
 *     whose directories and symlink farm are the installer's own record. See
 *     resolvers/pnpm.ts and ADR-0044.
 *   - **Yarn Plug'n'Play**: the PnP state, read as data -- `.pnp.data.json`,
 *     or the literal extracted from `.pnp.cjs` as text. Never evaluated. See
 *     resolvers/yarn-pnp.ts and ADR-0045.
 *   - **Every flat layout** -- Yarn Classic, Yarn Berry's node-modules
 *     linker, Bun, pnpm's hoisted linker: the installed packages' own
 *     manifests, resolved by node's algorithm. See
 *     resolvers/manifest-walk.ts and ADR-0046. Detection names the manager;
 *     the read is the same for all of them.
 *
 * Direct-versus-transitive is reconstructed from the root `package.json`'s
 * dependency sections in every case, and the attribution walk is shared.
 * No subprocess anywhere, so this adds milliseconds rather than seconds to an
 * install.
 */

/** The server's own ordering. Most privileged wins when two entries collide. */
const PRECEDENCE: Record<Scope, number> = { runtime: 30, optional: 20, dev: 10 };

/**
 * Where a direct dependency was declared, and the constraint it asked for.
 *
 * peerDependencies are included because npm 7 and later install them, so they
 * are on disk and are named in the manifest the reader edits. Which section a
 * package was declared in decides `relationship`, never `scope` -- the scope
 * comes from what the installer actually flagged.
 */
const MANIFEST_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

export interface PackageEntry {
    purl: string;
    name: string;
    version: string;
    scope: Scope;
    relationship: 'direct' | 'transitive';
    depth: number;
    requestedConstraint: string | null;
    paths?: string[][];
}

/** The manager whose metadata was actually read, for the payload. */
export interface PackageManagerInfo {
    name: string;
    version: string;
    lockfileName: string;
}

export type Resolution =
    /** A tree was read, by the manager named here. */
    | { outcome: 'resolved'; packages: PackageEntry[]; packageManager: PackageManagerInfo }
    /** Nothing installed, or a tree too broken to read. Reported already. */
    | { outcome: 'absent' };

export class Resolver {
    constructor(private readonly logger: Logger) {}

    resolve(projectRoot: string, includeDev: boolean, includeOptional: boolean): Resolution {
        const hidden = join(projectRoot, 'node_modules', '.package-lock.json');

        // npm's record first. A tree carrying more than one installer's state
        // was installed twice, and the hidden lockfile is the record this
        // client has always read.
        if (isFile(hidden)) {
            const graph = Graph.read(hidden, this.logger);

            if (graph === null) {
                return { outcome: 'absent' };
            }

            return this.entries(graph, projectRoot, includeDev, includeOptional, {
                name: 'npm',
                version: npmUserAgentVersion(),
                lockfileName: 'package-lock.json',
            });
        }

        const pnpm = readPnpmTree(projectRoot, this.logger);

        if (pnpm.outcome === 'tree') {
            return this.entries(pnpm.tree, projectRoot, includeDev, includeOptional, {
                name: 'pnpm',
                version: pnpm.version,
                lockfileName: 'pnpm-lock.yaml',
            });
        }

        if (pnpm.outcome === 'hoisted') {
            return this.entries(
                readManifestWalkTree(projectRoot, this.logger),
                projectRoot,
                includeDev,
                includeOptional,
                {
                    name: 'pnpm',
                    version: pnpm.version,
                    lockfileName: 'pnpm-lock.yaml',
                },
            );
        }

        if (pnpm.outcome === 'unreadable') {
            return { outcome: 'absent' };
        }

        const yarnPnp = readYarnPnpTree(projectRoot, this.logger);

        if (yarnPnp.outcome === 'tree') {
            return this.entries(yarnPnp.tree, projectRoot, includeDev, includeOptional, {
                name: 'yarn',
                version: yarnPnp.version,
                lockfileName: 'yarn.lock',
            });
        }

        if (yarnPnp.outcome === 'unreadable') {
            return { outcome: 'absent' };
        }

        const flat = this.flatTreeManager(projectRoot);

        if (flat !== null) {
            return this.entries(
                readManifestWalkTree(projectRoot, this.logger),
                projectRoot,
                includeDev,
                includeOptional,
                flat,
            );
        }

        this.logger.debug('no installed tree found; nothing to report.');

        return { outcome: 'absent' };
    }

    /**
     * Flat `node_modules` layouts, named by the manager that installed them
     * -- detection from what is on disk, never from the user agent. The tree
     * itself is read the same way for all of them: from the installed
     * packages' own manifests (resolvers/manifest-walk.ts, ADR-0046).
     * Plug'n'Play never reaches here; resolvers/yarn-pnp.ts owns its files.
     */
    private flatTreeManager(projectRoot: string): PackageManagerInfo | null {
        const has = (relative: string) => exists(join(projectRoot, relative));

        if (!has('node_modules')) {
            return null;
        }

        // Berry's node-modules linker leaves state markers; Classic leaves
        // only its lockfile. Both are Yarn's flat trees.
        if (has('node_modules/.yarn-state.yml') || has('.yarn/install-state.gz') || has('yarn.lock')) {
            return {
                name: 'yarn',
                version: pinnedManagerVersion(projectRoot, 'yarn'),
                lockfileName: 'yarn.lock',
            };
        }

        if (has('bun.lockb') || has('bun.lock')) {
            return {
                name: 'bun',
                version: pinnedManagerVersion(projectRoot, 'bun'),
                lockfileName: 'bun.lock',
            };
        }

        return null;
    }

    private entries(
        tree: InstalledTree,
        projectRoot: string,
        includeDev: boolean,
        includeOptional: boolean,
        packageManager: PackageManagerInfo,
    ): Resolution {
        const direct = this.directDependencies(projectRoot);
        const attribution = tree.attribute(Object.keys(direct));

        const entries: PackageEntry[] = [];
        const purlByPath = new Map<string, string>();
        const chains = new Map<number, string[][]>();

        for (const node of tree.installed().values()) {
            if (node.scope === 'dev' && !includeDev) {
                continue;
            }

            if (node.scope === 'optional' && !includeOptional) {
                continue;
            }

            const attributed = attribution.get(node.path);
            // A direct dependency is one the root manifest names AND that node
            // resolved at the top level. A nested copy of the same name is not
            // the one the manifest asked for.
            const isDirect = attributed?.depth === 0;

            entries.push({
                purl: purl(node.name, node.version),
                name: node.name,
                version: node.version,
                scope: node.scope,
                relationship: isDirect ? 'direct' : 'transitive',
                // Without an attribution -- a package nothing in the manifest
                // can reach, such as one behind a workspace link -- the
                // relationship is all there is to go on.
                depth: attributed?.depth ?? (isDirect ? 0 : 1),
                requestedConstraint: (isDirect ? direct[node.name] : undefined) ?? null,
            });

            const index = entries.length - 1;
            purlByPath.set(node.path, entries[index]?.purl ?? '');

            if (attributed !== undefined && attributed.paths.length > 0) {
                chains.set(index, attributed.paths);
            }
        }

        for (const [index, candidates] of chains) {
            const paths = pathsAsPurls(candidates, purlByPath);
            const entry = entries[index];

            if (entry !== undefined && paths.length > 0) {
                entry.paths = paths;
            }
        }

        return {
            outcome: 'resolved',
            packages: dedupe(entries).sort((a, b) => compare(a.purl, b.purl)),
            packageManager,
        };
    }

    /**
     * @returns Package name => the constraint the root asked for.
     */
    private directDependencies(projectRoot: string): Record<string, string | null> {
        let decoded: unknown;

        try {
            decoded = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
        } catch {
            return {};
        }

        if (decoded === null || typeof decoded !== 'object') {
            return {};
        }

        const manifest = decoded as Record<string, unknown>;
        const direct: Record<string, string | null> = {};

        for (const section of MANIFEST_SECTIONS) {
            const links = manifest[section];

            if (links === null || typeof links !== 'object' || Array.isArray(links)) {
                continue;
            }

            for (const [name, constraint] of Object.entries(links as Record<string, unknown>)) {
                // First section wins, so a package listed in both dependencies
                // and peerDependencies reports the constraint that installs it.
                if (!Object.hasOwn(direct, name)) {
                    direct[name] = typeof constraint === 'string' ? constraint : null;
                }
            }
        }

        return direct;
    }
}

/**
 * Collapse entries that share a purl, most privileged winning.
 *
 * **The server does this before it computes the digest**, so a client that does
 * not do it first disagrees with the server about the digest and every report
 * carries a spurious `digest_mismatch`. It matters far more here than it does
 * for Composer, where a name has exactly one version: npm routinely installs
 * the same version of the same package at several depths, and each one is a
 * separate entry in the hidden lockfile.
 */
function dedupe(entries: PackageEntry[]): PackageEntry[] {
    const seen = new Map<string, PackageEntry>();

    for (const entry of entries) {
        const existing = seen.get(entry.purl);

        if (existing === undefined) {
            seen.set(entry.purl, entry);

            continue;
        }

        seen.set(entry.purl, merge(existing, entry));
    }

    return [...seen.values()];
}

function merge(a: PackageEntry, b: PackageEntry): PackageEntry {
    const merged: PackageEntry = {
        purl: a.purl,
        name: a.name,
        version: a.version,
        scope: PRECEDENCE[b.scope] > PRECEDENCE[a.scope] ? b.scope : a.scope,
        relationship: a.relationship === 'direct' || b.relationship === 'direct' ? 'direct' : 'transitive',
        depth: Math.min(a.depth, b.depth),
        requestedConstraint: a.requestedConstraint ?? b.requestedConstraint,
    };

    // First non-null wins, like the server's own merge. Two entries for one
    // purl are the same package, so they cannot honestly disagree about how it
    // was reached; taking either is as good as taking the other.
    const paths = a.paths ?? b.paths;

    if (paths !== undefined) {
        merged.paths = paths;
    }

    return merged;
}

/**
 * Chains of install paths become chains of purls, root-first.
 *
 * A chain through a package that is not itself in this report -- a dev
 * dependency under `include.dev: false`, or one behind a workspace link -- is
 * dropped whole rather than shortened. A shortened chain claims a parent that
 * is not the parent.
 */
function pathsAsPurls(candidates: string[][], purlByPath: Map<string, string>): string[][] {
    const paths: string[][] = [];

    for (const chain of candidates) {
        const resolved: string[] = [];
        let complete = true;

        for (const ancestor of chain) {
            const ancestorPurl = purlByPath.get(ancestor);

            if (ancestorPurl === undefined) {
                complete = false;
                break;
            }

            resolved.push(ancestorPurl);
        }

        if (complete && resolved.length > 0) {
            paths.push(resolved);
        }
    }

    return paths;
}

/**
 * `pkg:npm/lodash@4.17.21`, and `pkg:npm/%40scope/name@1.0.0` when scoped --
 * the scope is the purl namespace, with its `@` percent-encoded.
 *
 * **npm names are not lowercased.** `Ecosystem::normalizeName()` on the server
 * lowercases Composer and Bitnami and returns npm names unchanged, so a client
 * that folded case here would create a second Package row for every legacy
 * mixed-case package.
 */
export function purl(name: string, version: string): string {
    const encodedVersion = encodeURIComponent(version);

    if (name.startsWith('@')) {
        const separator = name.indexOf('/');

        if (separator !== -1) {
            const scope = encodeURIComponent(name.slice(0, separator));
            const rest = encodeURIComponent(name.slice(separator + 1));

            return `pkg:npm/${scope}/${rest}@${encodedVersion}`;
        }
    }

    return `pkg:npm/${encodeURIComponent(name)}@${encodedVersion}`;
}

/** Byte-wise, so ordering never depends on a locale. */
function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * npm sets `npm_config_user_agent` for anything it runs, in the shape
 * `npm/10.9.0 node/v22.11.0 linux x64 workspaces/false`. Used for the version
 * only, never for detection -- the variable is absent outside an install and
 * lies when one manager shells out to another.
 */
export function npmUserAgentVersion(): string {
    const agent = process.env.npm_config_user_agent;
    const matched = agent === undefined ? null : /(?:^|\s)npm\/(\S+)/.exec(agent);

    return matched?.[1] ?? 'unknown';
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function exists(path: string): boolean {
    try {
        statSync(path);

        return true;
    } catch {
        return false;
    }
}
