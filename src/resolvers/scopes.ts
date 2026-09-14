import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scope } from '../graph.js';

/**
 * Scope computation shared by the readers whose installed state carries no
 * per-node dev/optional flags (pnpm's store, Yarn's PnP data).
 *
 * A path class says how one route from the manifest reaches a package.
 * Bit 1 -- the route starts at devDependencies. Bit 2 -- it crosses an
 * optionalDependencies link anywhere. Per node the walk accumulates the *set*
 * of classes seen, as a bitmask of `1 << class`, which is exactly the input
 * npm's own dev / optional / devOptional flags are computed from.
 */
export const DEV = 1;
export const OPTIONAL = 2;

/**
 * Which root-manifest section seeds which path class, first hit winning.
 * optionalDependencies before devDependencies: an optional dependency is
 * installed in production, so it outranks a dev declaration of the same name.
 */
const SECTION_SEEDS: ReadonlyArray<[string, number]> = [
    ['dependencies', 0],
    ['optionalDependencies', OPTIONAL],
    ['devDependencies', DEV],
    // npm 7+, pnpm and Yarn all install a root manifest's peers.
    ['peerDependencies', 0],
];

export interface ScopeEdge {
    readonly target: string;
    /** True when the parent declares the link under optionalDependencies. */
    readonly optional: boolean;
}

/**
 * Seed path classes from the root manifest, keyed by node id. Two manifest
 * names resolving to one node -- an alias beside the real name -- simply
 * contribute their classes to the same set.
 */
export function seedClasses(projectRoot: string, rootIds: Map<string, string>): [string, number][] {
    const seeds: [string, number][] = [];
    const manifest = readManifest(join(projectRoot, 'package.json'));

    if (manifest === null) {
        return seeds;
    }

    const seen = new Set<string>();

    for (const [section, pathClass] of SECTION_SEEDS) {
        for (const name of names(manifest[section])) {
            if (seen.has(name)) {
                continue;
            }

            seen.add(name);

            const id = rootIds.get(name);

            if (id !== undefined) {
                seeds.push([id, pathClass]);
            }
        }
    }

    return seeds;
}

/**
 * Accumulate every node's set of reachable path classes over the edges --
 * the input npm computes its own dev / optional / devOptional flags from.
 * The worklist carries (node, class) pairs and each of the four classes
 * enters a node's set at most once, so it terminates on any graph, cycles
 * included.
 */
export function propagateClasses(
    seeds: [string, number][],
    nodes: ReadonlySet<string>,
    edges: Map<string, readonly ScopeEdge[]>,
): Map<string, number> {
    const reached = new Map<string, number>();
    const queue: [string, number][] = [];

    const visit = (id: string, pathClass: number): void => {
        const mask = 1 << pathClass;
        const existing = reached.get(id) ?? 0;

        if ((existing & mask) === 0 && nodes.has(id)) {
            reached.set(id, existing | mask);
            queue.push([id, pathClass]);
        }
    };

    for (const [id, pathClass] of seeds) {
        visit(id, pathClass);
    }

    for (let index = 0; index < queue.length; index++) {
        const [id, pathClass] = queue[index] as [string, number];

        for (const edge of edges.get(id) ?? []) {
            visit(edge.target, edge.optional ? pathClass | OPTIONAL : pathClass);
        }
    }

    return reached;
}

/**
 * npm's own flag semantics, read off the class set: any plain production
 * path makes a package runtime; only-dev paths make it dev; everything else
 * -- every path optional, or npm's devOptional mix of dev and optional
 * routes -- reports optional, the more privileged of the two it means.
 */
export function scopeOfClasses(classes: number): Scope {
    if ((classes & (1 << 0)) !== 0) {
        return 'runtime';
    }

    if (classes === 1 << DEV) {
        return 'dev';
    }

    return 'optional';
}

/**
 * The `packageManager: "<name>@X.Y.Z"` pin in the root manifest -- the
 * committed value corepack enforces, and the closest thing a flat layout has
 * to an installer version. Absent or another manager's pin degrades to
 * `unknown`, never a guess.
 */
export function pinnedManagerVersion(projectRoot: string, manager: string): string {
    const pin = readManifest(join(projectRoot, 'package.json'))?.packageManager;
    const matched = typeof pin === 'string' ? new RegExp(`^${manager}@(\\S+)$`).exec(pin) : null;

    return matched?.[1] ?? 'unknown';
}

export function readManifest(path: string): Record<string, unknown> | null {
    let decoded: unknown;

    try {
        decoded = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }

    return isRecord(decoded) ? decoded : null;
}

export function names(links: unknown): string[] {
    return isRecord(links) ? Object.keys(links) : [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
