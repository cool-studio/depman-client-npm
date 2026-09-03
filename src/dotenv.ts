import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A deliberately tiny `.env` reader.
 *
 * The client cannot depend on `dotenv` -- it is a zero-dependency package by
 * design, and pulling a parser into every consumer's production install to read
 * one key would be a poor trade.
 *
 * It also does not need one. This reads a single named key and understands the
 * subset of the format people actually write: `KEY=value`, optional `export`,
 * quotes, comments. It performs **no variable interpolation** and never writes
 * to `process.env`, so reading a consumer's `.env` cannot change how their own
 * application later loads it.
 */

/**
 * A `.env` larger than this is not a `.env`.
 *
 * The guard matters because this runs inside somebody else's `npm install`: a
 * pathological file must not turn a post-install hook into a memory problem.
 */
const MAX_BYTES = 256 * 1024;

/**
 * One key's value, or null.
 *
 * **Only the requested key is ever returned.** A `.env` is the densest
 * concentration of secrets in a typical project, and this function exists to
 * take exactly one thing out of it.
 */
export function get(projectRoot: string, key: string): string | null {
    const path = join(projectRoot, '.env');

    let size: number;

    try {
        const stats = statSync(path);

        if (!stats.isFile()) {
            return null;
        }

        size = stats.size;
    } catch {
        return null;
    }

    if (size > MAX_BYTES) {
        return null;
    }

    let contents: string;

    try {
        contents = readFileSync(path, 'utf8');
    } catch {
        return null;
    }

    for (const line of contents.split(/\r?\n/)) {
        const value = match(line, key);

        if (value !== null) {
            return value;
        }
    }

    return null;
}

/**
 * The value on this line if it assigns `key`, otherwise null.
 */
function match(rawLine: string, key: string): string | null {
    let line = rawLine.trim();

    if (line === '' || line.startsWith('#')) {
        return null;
    }

    // `export FOO=bar` is common in files people also source from a shell.
    if (line.startsWith('export ')) {
        line = line.slice(7).replace(/^\s+/, '');
    }

    const separator = line.indexOf('=');

    if (separator === -1 || line.slice(0, separator).replace(/\s+$/, '') !== key) {
        return null;
    }

    return clean(line.slice(separator + 1).replace(/^\s+/, ''));
}

/**
 * Strip surrounding quotes, or an inline comment from an unquoted value.
 */
function clean(value: string): string | null {
    for (const quote of ['"', "'"]) {
        if (value.startsWith(quote)) {
            const closing = value.indexOf(quote, 1);

            // An unterminated quote is a broken line, not a value. Guessing at
            // what was meant is how a truncated token gets sent.
            return closing === -1 ? null : orNull(value.slice(1, closing));
        }
    }

    // ` #` and not `#`: a token could legitimately contain a hash, and only a
    // hash preceded by whitespace starts a comment.
    const comment = value.indexOf(' #');

    return orNull((comment === -1 ? value : value.slice(0, comment)).trim());
}

function orNull(value: string): string | null {
    return value === '' ? null : value;
}
