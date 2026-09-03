import { basename } from 'node:path';
import { decode } from './client.js';
import { Config } from './config.js';
import type { Logger } from './logger.js';
import { PushResult } from './push-result.js';
import type { HttpResponse, Reporter, WirePayload } from './reporter.js';
import { Spool } from './spool.js';
import type { Env } from './token.js';
import * as Token from './token.js';

/**
 * Drains the offline spool.
 *
 * Writing to a queue that nothing empties is not resilience; it is a directory
 * of files that will never be sent. This is the other half of Spool, and the
 * command the client specification requires (docs/ingest-clients.md section 9).
 *
 * Deliberately a separate orchestrator from Client rather than a mode of it.
 * The two share almost nothing: a report resolves a tree and builds a payload,
 * a push has a payload already and must not touch the installed tree at all --
 * the whole point is that it runs long after the install that produced it, when
 * node_modules may look nothing like it did.
 */
export class Pusher {
    constructor(
        private readonly logger: Logger,
        private readonly reporter: Reporter,
    ) {}

    async push(projectRoot: string, env: Env = {}): Promise<PushResult> {
        const config = Config.load(projectRoot, this.logger, env);

        if (config === null) {
            return PushResult.skipped('no depman.json');
        }

        if (!config.isEnabled(env)) {
            return PushResult.skipped('disabled');
        }

        const spool = new Spool(config.spoolDirectory(env), this.logger);
        const pending = spool.pending();

        if (pending.length === 0) {
            return PushResult.drained(0, 0);
        }

        const endpoint = config.endpoint(env);
        const found = Token.locate(endpoint, env, projectRoot);

        if (found === null) {
            // The spool is left exactly as it was. Discarding an inventory
            // because this particular invocation had no credential would throw
            // away the thing the spool exists to protect.
            this.logger.info('no token found, skipping. Set DEPMAN_TOKEN in .env or the environment to push.');

            return PushResult.skipped('no token');
        }

        this.logger.debug(`token found via ${found.source}.`);

        return this.drain(spool, pending, endpoint, found.value, config.timeoutMs(env));
    }

    /**
     * @param pending Oldest first.
     */
    private async drain(
        spool: Spool,
        pending: string[],
        endpoint: string,
        token: string,
        timeoutMs: number,
    ): Promise<PushResult> {
        let sent = 0;
        let discarded = 0;

        for (const [index, file] of pending.entries()) {
            const payload = spool.read(file);

            if (payload === null) {
                // A truncated write. It will never decode, and at the cap a
                // slot that can never empty evicts payloads that could.
                this.logger.warn(`a spooled report could not be read and has been discarded: ${basename(file)}`);
                spool.forget(file);
                discarded++;

                continue;
            }

            const response = await this.reporter.send(endpoint, token, replay(payload), timeoutMs);
            const remaining = pending.length - index;

            if (response === null) {
                // Still offline. This is the ordinary case and not an error:
                // the queue is doing its job.
                return PushResult.stopped(sent, discarded, remaining, 'could not reach DepMan', false);
            }

            const status = response.status;

            if (status === 200 || status === 202) {
                spool.forget(file);
                sent++;

                continue;
            }

            // Stop rather than work through the rest. Every remaining payload
            // goes to the same host with the same token, so whatever refused
            // this one refuses all of them, and hammering a rate limiter is how
            // a drain turns into an outage of its own.
            if (status === 429 || status >= 500) {
                return PushResult.stopped(
                    sent,
                    discarded,
                    remaining,
                    status === 429 ? 'rate limited' : 'DepMan is unavailable',
                    false,
                );
            }

            if (status === 401 || status === 403) {
                // Fixable, and fixable once for the whole queue -- so keep every
                // payload and say what to fix. Discarding here would lose an
                // inventory to a rotated token.
                this.logger.error(`${reason(response)} Nothing was discarded; fix the token and push again.`);

                return PushResult.stopped(sent, discarded, remaining, 'the token was rejected', true);
            }

            if (status < 400) {
                // A 3xx: the endpoint redirects, and we do not follow redirects
                // (section 7). That is a configuration problem rather than a
                // property of this payload, so **nothing is discarded** -- a
                // proxy answering 302 must not be able to eat a whole spool one
                // file at a time.
                this.logger.error(
                    `unexpected HTTP ${status} from ${endpoint}; the endpoint may be redirecting. Nothing was discarded.`,
                );

                return PushResult.stopped(sent, discarded, remaining, `unexpected HTTP ${status}`, true);
            }

            // A 4xx -- 5xx returned above -- and a permanent property of this
            // payload: a wire version we have retired, a project that was
            // renamed. Retrying it forever hides the misconfiguration instead
            // of surfacing it, which is the same rule section 8 applies to a
            // live report.
            this.logger.error(`a spooled report was rejected and has been discarded: ${reason(response)}`);
            spool.forget(file);
            discarded++;
        }

        return PushResult.drained(sent, discarded);
    }
}

/**
 * Mark the payload as a replay, leaving everything else untouched.
 *
 * `spool-replay` is a documented reason the ingest API accepts and nothing else
 * can produce, so it is the only way the server can tell a tree that arrived
 * late from one that arrived now. It is safe to rewrite because the manifest
 * digest covers semantic content only -- purl, scope, relationship -- and never
 * the reason, so a replayed payload still deduplicates against whatever else
 * reported that tree.
 */
function replay(payload: WirePayload): WirePayload {
    if (payload.report !== null && typeof payload.report === 'object') {
        payload.report.reason = 'spool-replay';
    }

    return payload;
}

function reason(response: HttpResponse): string {
    const decoded = decode(response.body);
    const error = decoded.error;
    const fields = error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};

    const code = typeof fields.code === 'string' ? fields.code : `http_${response.status}`;
    const message = typeof fields.message === 'string' ? fields.message : 'The report was rejected.';

    return `${code}: ${message}`;
}
