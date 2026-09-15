/**
 * The package's entry point.
 *
 * **This exists so that `@depman/client` resolves as a package at all.** The
 * client is a CLI -- consumers run its `bin` from a post-install hook and
 * nothing here is on that path -- but a manifest with a `bin` and no `main`
 * is a package Node's resolver cannot answer for. Tooling that enumerates a
 * project's dependencies and resolves each one hits `legacyMainResolve`,
 * finds no `main` and no `index.js`, and throws ERR_MODULE_NOT_FOUND. That is
 * not a hypothetical: `@roots/bud` resolves every dependency to discover
 * extension commands, so installing this client broke `bud build` outright
 * for anyone whose project used it (ADR-0048).
 *
 * So the re-exports below are deliberately the pieces `cli.ts` itself is
 * composed from, and nothing more -- an entry point that names the CLI's own
 * parts cannot drift away from what the package actually does. **Importing
 * this module must stay free of side effects**, which is why `main` does not
 * point at `cli.ts`: that module runs `main()` when it loads.
 */
export { Client, decode } from './client.js';
export { Config, type ResolvedEnvironment } from './config.js';
export { Gate, RANKS, THRESHOLDS } from './gate.js';
export { BREACHED, ERRORED, GateResult, type GateStatus, PASSED, TIMED_OUT } from './gate-result.js';
export {
    type Attribution,
    Graph,
    type InstalledNode,
    type InstalledTree,
    type Scope,
} from './graph.js';
export * as Hook from './hook.js';
export { LEVELS, type LevelName, Logger, type Sink } from './logger.js';
export { PushResult, type PushStatus } from './push-result.js';
export { Pusher } from './pusher.js';
export {
    CLIENT_NAME,
    CLIENT_VERSION,
    type HttpResponse,
    Reporter,
    WIRE_VERSION,
    type WirePayload,
} from './reporter.js';
export {
    type PackageEntry,
    type PackageManagerInfo,
    type Resolution,
    Resolver,
} from './resolver.js';
export { Result, type ResultStatus } from './result.js';
export { Spool } from './spool.js';
export * as Token from './token.js';
