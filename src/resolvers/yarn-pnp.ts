import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Attribution, attributeWalk, type InstalledNode, type InstalledTree } from '../graph.js';
import type { Logger } from '../logger.js';
import { isRecord, propagateClasses, readManifest, type ScopeEdge, scopeOfClasses, seedClasses } from './scopes.js';

/**
 * The installed dependency graph of a Yarn Plug'n'Play project, read from the
 * PnP **state as data** -- never by executing `.pnp.cjs`.
 *
 * The state is documented by Yarn's PnP specification and reachable without
 * evaluation, twice over: `.pnp.data.json` (written when `pnpEnableInlining:
 * false`) is pure JSON, and by default the same JSON is embedded in
 * `.pnp.cjs` as a single-quoted string literal (`const RAW_RUNTIME_STATE =`)
 * that a bounded text reader can extract and `JSON.parse`. Anything that does
 * not match those exact shapes refuses loudly; nothing ever falls back to
 * evaluating the file. ADR-0045 records why this lifts ADR-0044's refusal.
 *
 * **Nodes are keyed by locator** -- `name@reference`, e.g.
 * `debug@virtual:<hash>#npm:4.4.3`. Virtual instances are peer-dependency
 * variants, distinct installed copies exactly as pnpm's peer-suffixed store
 * keys are, and instances of one version deduplicate on purl before the
 * digest. Versions are parsed from a **whitelist** of reference protocols
 * (`npm:`, `virtual:…#npm:`, `patch:…#npm%3A…`); every other protocol --
 * `workspace:` (the consumer's own code), `portal:`, `link:`, `exec:`,
 * `file:` -- is skipped as a node, with chains through it dropped whole,
 * per section 5's no-resolvable-version rule. Never guess a version out of
 * a reference outside the whitelist.
 *
 * Edges are each instance's `packageDependencies` -- resolved facts, minus
 * the self-edge and `null` (unmet peer) entries. PnP data does not say which
 * *transitive* edges are optionalDependencies (the manifests live inside zip
 * archives this client will not parse), so scopes are computed from the root
 * manifest's sections over plain edges: root-level optionals classify
 * correctly, and a transitively-optional package reports its parent's class
 * -- the more privileged reading, the same direction as devOptional.
 */

export type YarnPnpRead =
    | { outcome: 'tree'; tree: InstalledTree; version: string }
    /** Recognisably PnP, not readable as data. Already reported loudly. */
    | { outcome: 'unreadable' }
    | { outcome: 'absent' };

export function readYarnPnpTree(projectRoot: string, logger: Logger): YarnPnpRead {
    const dataPath = join(projectRoot, '.pnp.data.json');
    const runtimePath = [join(projectRoot, '.pnp.cjs'), join(projectRoot, '.pnp.js')].find(isFile);

    let raw: string | null = null;

    if (isFile(dataPath)) {
        try {
            raw = readFileSync(dataPath, 'utf8');
        } catch {
            raw = null;
        }
    } else if (runtimePath !== undefined) {
        raw = extractInlinedState(readSafely(runtimePath) ?? '');
    } else {
        return { outcome: 'absent' };
    }

    let state: unknown = null;

    try {
        state = raw === null ? null : JSON.parse(raw);
    } catch {
        state = null;
    }

    const registry = isRecord(state) ? state.packageRegistryData : null;

    if (!Array.isArray(registry)) {
        // Loud, and it says what this client will not do: against an
        // installed tree, a silent skip reads as "no vulnerabilities".
        logger.warn(
            "Yarn Plug'n'Play installed this project, and its state could not be read as data. " +
                'This client will not execute .pnp.cjs -- use the CI step or the HTTP contract instead, ' +
                'or set pnpEnableInlining: false so Yarn writes .pnp.data.json.',
        );

        return { outcome: 'unreadable' };
    }

    return {
        outcome: 'tree',
        tree: buildTree(projectRoot, registry, logger),
        version: yarnVersion(projectRoot),
    };
}

class YarnPnpTree implements InstalledTree {
    constructor(
        private readonly nodes: Map<string, InstalledNode>,
        /** Locator => the locators it depends on, already resolved. */
        private readonly edges: Map<string, string[]>,
        /** Root-manifest dependency name => locator. */
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

function buildTree(projectRoot: string, registry: unknown[], logger: Logger): InstalledTree {
    /** Locator => {name, version}; only whitelisted references become nodes. */
    const identified = new Map<string, { name: string; version: string }>();
    const rawEdges = new Map<string, string[]>();
    /** The top-level entry's own dependency map: manifest name => locator. */
    const rootIds = new Map<string, string>();
    let skipped = 0;

    for (const entry of registry) {
        if (!Array.isArray(entry) || entry.length < 2 || !Array.isArray(entry[1])) {
            continue;
        }

        const [entryName, instances] = entry as [unknown, unknown[]];

        for (const instance of instances) {
            if (!Array.isArray(instance) || !isRecord(instance[1])) {
                continue;
            }

            const reference = instance[0];
            const info = instance[1];

            // The top-level entry ([null, [[null, …]]]) mirrors the root
            // workspace; its dependency map is where the root manifest's
            // names resolve.
            if (entryName === null && reference === null) {
                for (const [depName, target] of dependencyPairs(info.packageDependencies)) {
                    rootIds.set(depName, target);
                }

                continue;
            }

            if (typeof entryName !== 'string' || typeof reference !== 'string') {
                continue;
            }

            const version = versionOf(reference);

            // workspace: locators are the consumer's own code; anything else
            // outside the whitelist has no version this client will guess at.
            if (version === null) {
                if (!reference.startsWith('workspace:')) {
                    skipped += 1;
                }

                continue;
            }

            const id = `${entryName}@${reference}`;
            identified.set(id, { name: entryName, version });

            const targets: string[] = [];

            for (const [, target] of dependencyPairs(info.packageDependencies)) {
                if (target !== id) {
                    targets.push(target);
                }
            }

            rawEdges.set(id, targets);
        }
    }

    if (skipped > 0) {
        logger.debug(
            `${skipped} PnP locators use a protocol this client does not read ` +
                '(portal:, link:, exec:, …) and were skipped; chains through them are dropped whole.',
        );
    }

    const reached = propagateClasses(
        seedClasses(projectRoot, rootIds),
        new Set(identified.keys()),
        new Map(
            [...rawEdges].map(([id, targets]) => [
                id,
                targets.map((target): ScopeEdge => ({ target, optional: false })),
            ]),
        ),
    );

    const nodes = new Map<string, InstalledNode>();

    for (const id of [...identified.keys()].sort()) {
        const classes = reached.get(id);

        if (classes === undefined) {
            continue;
        }

        const { name, version } = identified.get(id) as { name: string; version: string };
        nodes.set(id, { path: id, name, version, scope: scopeOfClasses(classes) });
    }

    const edges = new Map<string, string[]>();

    for (const [id, targets] of rawEdges) {
        if (nodes.has(id)) {
            edges.set(
                id,
                targets.filter((target) => nodes.has(target)),
            );
        }
    }

    return new YarnPnpTree(nodes, edges, rootIds);
}

/**
 * An instance's `packageDependencies`, yielded as (name, target locator)
 * pairs. Per the PnP spec a value is `null` (an unmet peer -- no edge), a
 * reference string, or an `[aliasedName, reference]` tuple; anything else is
 * ignored rather than guessed at.
 */
function dependencyPairs(value: unknown): [string, string][] {
    const pairs: [string, string][] = [];

    if (!Array.isArray(value)) {
        return pairs;
    }

    for (const dependency of value) {
        if (!Array.isArray(dependency) || typeof dependency[0] !== 'string') {
            continue;
        }

        const name = dependency[0];
        const reference = dependency[1];

        if (typeof reference === 'string') {
            pairs.push([name, `${name}@${reference}`]);
        } else if (Array.isArray(reference) && typeof reference[0] === 'string' && typeof reference[1] === 'string') {
            // An alias: the edge is requested under `name` but resolves to a
            // different package. The target's identity is the real one.
            pairs.push([name, `${reference[0]}@${reference[1]}`]);
        }
    }

    return pairs;
}

/**
 * The reference-protocol whitelist. Null means "no version this client will
 * assert": the caller skips the node and lets chains through it drop.
 */
export function versionOf(reference: string): string | null {
    // virtual:<hash>#<inner> -- a peer-dependency variant; the inner
    // reference carries the version, the full locator stays the identity.
    if (reference.startsWith('virtual:')) {
        const separator = reference.indexOf('#');

        return separator === -1 ? null : versionOf(reference.slice(separator + 1));
    }

    // npm:X.Y.Z, optionally with ::params (archive URLs and friends).
    if (reference.startsWith('npm:')) {
        const version = reference.slice('npm:'.length).split('::')[0] ?? '';

        return version === '' ? null : version;
    }

    // patch:<name>@npm%3AX.Y.Z#<patch source> -- Yarn patches TypeScript by
    // default, so this is common. The patched source names the version; the
    // inner reference is URL-encoded.
    if (reference.startsWith('patch:')) {
        const separator = reference.indexOf('#');
        const locator =
            separator === -1 ? reference.slice('patch:'.length) : reference.slice('patch:'.length, separator);
        const at = locator.indexOf('@');

        if (at <= 0) {
            return null;
        }

        try {
            const inner = decodeURIComponent(locator.slice(at + 1));

            return inner.startsWith('npm:') ? versionOf(inner) : null;
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * Extract the JSON literal Yarn inlines into `.pnp.cjs`, as text. The shape
 * is `const RAW_RUNTIME_STATE =` followed by a single-quoted string whose
 * only escapes are `\`-newline continuations, `\\` and `\'` (verified
 * against real Yarn output). Anything else returns null -- the caller
 * refuses loudly, and nothing ever evaluates the file.
 */
export function extractInlinedState(text: string): string | null {
    const marker = text.indexOf('const RAW_RUNTIME_STATE =');

    if (marker === -1) {
        return null;
    }

    const open = text.indexOf("'", marker);

    if (open === -1) {
        return null;
    }

    let out = '';

    for (let i = open + 1; i < text.length; i++) {
        const character = text[i];

        if (character === '\\') {
            const next = text[i + 1];

            if (next === '\n') {
                i += 1;
            } else if (next === '\\' || next === "'") {
                out += next;
                i += 1;
            } else {
                return null;
            }

            continue;
        }

        if (character === "'") {
            return out;
        }

        out += character;
    }

    return null;
}

/**
 * `packageManager: "yarn@X.Y.Z"` in the root manifest is the committed pin
 * corepack enforces -- the closest thing PnP state has to an installer
 * version. Absent or unrecognisable degrades to `unknown`, never a guess.
 */
function yarnVersion(projectRoot: string): string {
    const pin = readManifest(join(projectRoot, 'package.json'))?.packageManager;
    const matched = typeof pin === 'string' ? /^yarn@(\S+)$/.exec(pin) : null;

    return matched?.[1] ?? 'unknown';
}

function readSafely(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}
