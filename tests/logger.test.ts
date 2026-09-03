import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Logger } from '../src/logger.js';
import { Recorder } from './helpers.js';

describe('Logger', () => {
    test('it writes below the configured level and stays quiet above it', () => {
        const sink = new Recorder();
        const logger = new Logger('warn', sink);

        logger.error('an error');
        logger.warn('a warning');
        logger.info('an info');
        logger.debug('a debug');

        assert.deepEqual(sink.lines, ['DepMan: an error', 'DepMan: a warning']);
    });

    test('silent writes nothing', () => {
        const sink = new Recorder();
        const logger = new Logger('silent', sink);

        logger.error('an error');

        assert.deepEqual(sink.lines, []);
    });

    test('an unknown level falls back to warn rather than to silence', () => {
        const sink = new Recorder();
        const logger = new Logger('nonsense', sink);

        logger.warn('a warning');
        logger.info('an info');

        assert.deepEqual(sink.lines, ['DepMan: a warning']);
    });

    test('always() ignores the level entirely', () => {
        // Reserved for the one case where staying quiet would be
        // irresponsible: a credential committed to source control.
        const sink = new Recorder();

        new Logger('silent', sink).always('a token is in your config');

        assert.deepEqual(sink.lines, ['DepMan: a token is in your config']);
    });

    test('every line is prefixed so it is attributable in someone else’s build log', () => {
        const sink = new Recorder();

        new Logger('debug', sink).debug('hello');

        assert.match(sink.text(), /^DepMan: /);
    });

    test('it defaults to stderr, never stdout', () => {
        // stdout may be parsed by whatever invoked the install.
        assert.equal(new Logger('debug')['sink' as keyof Logger], process.stderr);
    });
});
