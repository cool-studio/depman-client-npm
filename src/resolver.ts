import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Graph, type Scope } from './graph.js';
import type { Logger } from './logger.js';

/**
 * Reads the installed dependency tree from npm's own metadata.
 *
 * Deliberately reads `node_modules/.package-lock.json` -- npm's hidden
 * lockfile, written by the installer to describe what it put on disk -- rather
 * than the project's `package-lock.json` or a `npm ls --json` subprocess:
 *
 *   - No subprocess, so it adds milliseconds rather than seconds to an install.
 *   - It is exactly what is on disk, not a fresh re-solve.
 *   - It carries `dev`, `optional` and `devOptional` per package, which is what
 *     distinguishes a dev dependency from a runtime one.
 *
 * Direct-versus-transitive is not in it, so it is reconstructed from the root
 * `package.json`'s dependency sections. Attribution -- the depth and ancestry
 * chains that answer "which of my dependencies pulled this in?" -- comes from
 * the per-entry `dependencies` maps in the same file; see Graph.
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

export class Resolver {
    constructor(private readonly logger: Logger) {}

    /**
     * Null when the tree cannot be read.
     */
    resolve(projectRoot: string, includeDev: boolean, includeOptional: boolean): PackageEntry[] | null {
        const graph = Graph.read(join(projectRoot, 'node_modules', '.package-lock.json'), this.logger);

        if (graph === null) {
            return null;
        }

        const direct = this.directDependencies(projectRoot);
        const attribution = graph.attribute(Object.keys(direct));

        const entries: PackageEntry[] = [];
        const purlByPath = new Map<string, string>();
        const chains = new Map<number, string[][]>();

        for (const node of graph.installed().values()) {
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

        return dedupe(entries).sort((a, b) => compare(a.purl, b.purl));
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
