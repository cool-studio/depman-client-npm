#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from './client.js';
import { Config } from './config.js';
import { Gate } from './gate.js';
import { BREACHED, type GateResult, PASSED } from './gate-result.js';
import * as Hook from './hook.js';
import { Logger } from './logger.js';
import { Pusher } from './pusher.js';
import { Reporter } from './reporter.js';
import { Resolver } from './resolver.js';
import type { Result } from './result.js';
import * as Token from './token.js';

const USAGE = `depman — report installed npm dependencies to DepMan

  depman report [--fail-on-error]   Report the installed tree now
  depman push  [--fail-on-error]    Send everything left in the offline spool
  depman doctor                     Show the resolved configuration
  depman install-hook               Add the postinstall hook to package.json

CI gating — the only mode that may fail a build. Put it in its own step,
never in a postinstall script:

  depman report --wait [--fail-on=<severity>] [--wait-timeout=<seconds>]

Waits for DepMan to scan the report, then exits 1 if any open finding in
that environment is at <severity> or worse, and 2 if it could not find
out. <severity> is one of critical, high, medium, low, unknown; the wait
defaults to 300 seconds.

The token is read from DEPMAN_TOKEN, DEPMAN_TOKEN_FILE, or
~/.depman/credentials. It must never be placed in depman.json, which is
committed to source control.
`;

/**
 * `report --wait [--fail-on=<severity>]`, printed and turned into an exit code.
 *
 * Everything that decides anything is in Gate; this only formats. See
 * docs/ingest-clients.md section 10.
 */
async function gate(root: string, logger: Logger, options: Options, result: Result): Promise<number> {
    const threshold = options['fail-on']?.toLowerCase() ?? null;

    // Clamped rather than honoured, exactly as the request timeout is: an
    // absurd value here is a typo, and a gate that waits for an hour has
    // stopped being a gate and become a hung build.
    const requested = Number.parseInt(options['wait-timeout'] ?? '300', 10);
    const timeout = Math.max(10, Math.min(Number.isFinite(requested) ? requested : 300, 3600));

    const verdict: GateResult = await new Gate(logger, new Reporter(logger)).run(root, result, threshold, timeout);

    const summary = verdict.summary();

    if (summary !== null) {
        process.stdout.write(`Open findings: ${summary}.\n`);
    }

    if (verdict.status === PASSED) {
        process.stdout.write(
            threshold === null ? 'Scan complete.\n' : `Gate passed: nothing at ${threshold} or above.\n`,
        );
    } else if (verdict.status === BREACHED) {
        process.stdout.write(`Gate FAILED: ${verdict.detail}.\n`);
    } else {
        process.stdout.write(`Gate could not decide: ${verdict.detail}\n`);
    }

    return verdict.exitCode();
}

type Options = Record<string, string | undefined>;

function parse(argv: string[]): Options {
    const options: Options = {};

    for (const argument of argv) {
        if (!argument.startsWith('--')) {
            continue;
        }

        const separator = argument.indexOf('=');

        if (separator === -1) {
            options[argument.slice(2)] = '1';
        } else {
            options[argument.slice(2, separator)] = argument.slice(separator + 1);
        }
    }

    return options;
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const command = argv[0] ?? 'help';
    const options = parse(argv.slice(1));
    const root = Hook.projectRoot();

    const logger = new Logger(options['log-level'] ?? process.env.DEPMAN_LOG_LEVEL ?? 'info');

    switch (command) {
        case 'report': {
            // The postinstall entry, which is the one path that must never
            // throw and never exit non-zero. It reports and returns.
            if (options.postinstall !== undefined) {
                await Hook.report();

                return 0;
            }

            const client = new Client(logger, new Resolver(logger), new Reporter(logger));
            const result = await client.report(root, 'manual');

            if (result.status === 'reported') {
                process.stdout.write(
                    `Reported ${result.packages} packages.${result.deduplicated ? ' (unchanged since the last report)' : ''}\n`,
                );
            } else if (result.status === 'spooled') {
                process.stdout.write(`Could not reach DepMan (${result.detail}); spooled for later.\n`);
            } else if (result.status === 'failed') {
                process.stdout.write(`Report rejected: ${result.detail}\n`);
            } else {
                process.stdout.write(`Skipped: ${result.detail}\n`);
            }

            // CI gating. --fail-on= implies --wait, because the findings a
            // threshold is compared against do not exist until the scan behind
            // the report has run. This is the only mode allowed to fail a build.
            if (options.wait !== undefined || options['fail-on'] !== undefined) {
                return gate(root, logger, options, result);
            }

            // Only an explicit --fail-on-error, or the config equivalent, makes
            // a failure exit non-zero. Everything else exits 0 by design.
            const failOnError =
                options['fail-on-error'] !== undefined || (Config.load(root, logger)?.failOnError() ?? false);

            return result.isFailure() && failOnError ? 1 : 0;
        }

        case 'push': {
            const push = await new Pusher(logger, new Reporter(logger)).push(root);

            if (push.status === 'drained') {
                process.stdout.write(
                    push.sent === 0 && push.discarded === 0
                        ? 'Nothing spooled.\n'
                        : `Pushed ${push.sent} spooled report${push.sent === 1 ? '' : 's'}.` +
                              `${push.discarded === 0 ? '' : ` Discarded ${push.discarded} that will never be accepted.`}\n`,
                );
            } else if (push.status === 'stopped') {
                process.stdout.write(
                    `Pushed ${push.sent} spooled report${push.sent === 1 ? '' : 's'}; ` +
                        `${push.remaining} still queued (${push.detail}).\n`,
                );
            } else {
                process.stdout.write(`Skipped: ${push.detail}\n`);
            }

            // Same contract as `report`: an undeliverable spool is what the
            // spool is for and exits 0. Only a rejection, and only when asked,
            // is non-zero.
            const failOnError =
                options['fail-on-error'] !== undefined || (Config.load(root, logger)?.failOnError() ?? false);

            return push.isFailure() && failOnError ? 1 : 0;
        }

        case 'doctor': {
            const config = Config.load(root, logger);

            if (config === null) {
                process.stdout.write(`No depman.json found in ${root}.\n`);

                return 0;
            }

            const endpoint = config.endpoint();
            const environment = config.environment();
            const token = Token.locate(endpoint, {}, root);

            // The source on every line, not just the token's. A `.env` shadows
            // a process env var for every setting, so "which of these three
            // won?" is the question doctor exists to answer.
            process.stdout.write(
                `Project:      ${config.project() ?? '(not set)'} (from ${config.sourceOf('project', 'DEPMAN_PROJECT')})\n`,
            );
            process.stdout.write(
                `Endpoint:     ${endpoint} (from ${config.sourceOf('endpoint', 'DEPMAN_ENDPOINT')})\n`,
            );
            process.stdout.write(`Environment:  ${environment.name} (from ${environment.resolvedFrom})\n`);
            // The source, not just "found". When the wrong mechanism wins the
            // symptom is a 401 with no clue which of four places produced the
            // credential — and this line is the answer.
            process.stdout.write(
                `Token:        ${token === null ? 'not found — set DEPMAN_TOKEN in .env or the environment' : `found via ${token.source}`}\n`,
            );
            process.stdout.write(`Include dev:  ${config.includeDev() ? 'yes' : 'no'}\n`);
            process.stdout.write(`Include opt:  ${config.includeOptional() ? 'yes' : 'no'}\n`);

            return 0;
        }

        case 'install-hook': {
            const path = join(root, 'package.json');
            let decoded: unknown;

            try {
                decoded = JSON.parse(readFileSync(path, 'utf8'));
            } catch {
                process.stdout.write('Could not read package.json.\n');

                return 1;
            }

            if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
                process.stdout.write('Could not read package.json.\n');

                return 1;
            }

            const manifest = decoded as Record<string, unknown>;
            const scripts: Record<string, unknown> =
                manifest.scripts !== null && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
                    ? (manifest.scripts as Record<string, unknown>)
                    : {};

            const existing = typeof scripts.postinstall === 'string' ? scripts.postinstall : '';
            const invocation = 'depman report --postinstall';

            // Chained rather than replaced. A consumer's own postinstall is
            // load-bearing, and silently dropping it would be exactly the kind
            // of build breakage section 0 forbids.
            if (!existing.includes(invocation)) {
                scripts.postinstall = existing === '' ? invocation : `${existing} && ${invocation}`;
            }

            manifest.scripts = scripts;
            writeFileSync(path, `${JSON.stringify(manifest, null, 4)}\n`);
            process.stdout.write('Added the DepMan hook to the postinstall script.\n');

            return 0;
        }

        default:
            process.stdout.write(USAGE);

            return 0;
    }
}

main().then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        // Nothing above should throw. If something does, say so on stderr and
        // exit 1 rather than dying with an unhandled rejection -- but note that
        // the postinstall path never reaches here, because Hook.report()
        // swallows everything itself.
        process.stderr.write(`DepMan: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    },
);
