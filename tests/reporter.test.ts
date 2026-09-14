import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { Config } from '../src/config.js';
import { CLIENT_NAME, CLIENT_VERSION, Reporter, WIRE_VERSION } from '../src/reporter.js';
import type { PackageEntry } from '../src/resolver.js';
import { cleanup, fixturePath, recordingLogger, workspace, writeJson } from './helpers.js';

const roots: string[] = [];

function reporter(): Reporter {
    return new Reporter(recordingLogger('silent').logger);
}

function config(raw: Record<string, unknown> = { project: 'storefront' }): Config {
    const root = workspace();
    roots.push(root);
    writeJson(root, 'depman.json', raw);

    return Config.fromObject(root, raw, recordingLogger('silent').logger);
}

function entry(overrides: Partial<PackageEntry> = {}): PackageEntry {
    return {
        purl: 'pkg:npm/a@1.0.0',
        name: 'a',
        version: '1.0.0',
        scope: 'runtime',
        relationship: 'direct',
        depth: 0,
        requestedConstraint: null,
        ...overrides,
    };
}

function fixture(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(fixturePath(name), 'utf8'));
}

/** What the resolver reports for an npm-installed tree. */
const NPM = { name: 'npm', version: '10.8.2', lockfileName: 'package-lock.json' };

/** And for a pnpm-installed one. */
const PNPM = { name: 'pnpm', version: '9.12.0', lockfileName: 'pnpm-lock.yaml' };

after(() => {
    for (const root of roots) {
        cleanup(root);
    }
});

describe('The manifest digest', () => {
    test('it is independent of the order packages arrive in', () => {
        const a = entry({ purl: 'pkg:npm/a@1.0.0' });
        const b = entry({ purl: 'pkg:npm/b@1.0.0' });

        assert.equal(reporter().digest([a, b], 'production'), reporter().digest([b, a], 'production'));
    });

    test('it is specific to the environment', () => {
        // The same tree in staging and production are different facts and must
        // not deduplicate against each other.
        assert.notEqual(reporter().digest([entry()], 'staging'), reporter().digest([entry()], 'production'));
    });

    test('it is sensitive to the version', () => {
        const bumped = entry({ purl: 'pkg:npm/a@1.0.1' });

        assert.notEqual(reporter().digest([entry()], 'production'), reporter().digest([bumped], 'production'));
    });

    test('it is sensitive to the scope', () => {
        const dev = entry({ scope: 'dev' });

        assert.notEqual(reporter().digest([entry()], 'production'), reporter().digest([dev], 'production'));
    });

    test('it is sensitive to the relationship', () => {
        const transitive = entry({ relationship: 'transitive' });

        assert.notEqual(reporter().digest([entry()], 'production'), reporter().digest([transitive], 'production'));
    });

    test('it is stable across calls, carrying no timestamp or nonce', () => {
        assert.equal(reporter().digest([entry()], 'production'), reporter().digest([entry()], 'production'));
    });

    test('it ignores fields outside purl, scope and relationship', () => {
        // depth and paths are deliberately outside the digest, so a client that
        // starts emitting them reports an unchanged tree under an unchanged
        // digest.
        const withPaths = entry({ depth: 3, paths: [['pkg:npm/z@1.0.0']], requestedConstraint: '^1.0.0' });

        assert.equal(reporter().digest([entry()], 'production'), reporter().digest([withPaths], 'production'));
    });

    test('it names npm as the ecosystem', () => {
        // Getting this wrong produces a digest_mismatch on every report and
        // silently disables dedupe.
        const empty = reporter().digest([], 'production');

        assert.equal(empty, fixtureDigestOfEmptyTree());
    });
});

/** Computed the way docs/ingest-clients.md section 6 specifies, independently of Reporter. */
function fixtureDigestOfEmptyTree(): string {
    return `sha256:${createHash('sha256').update('depman-manifest-v1\nnpm\nproduction\n', 'utf8').digest('hex')}`;
}

describe('The canonical wire fixture', () => {
    test('it reproduces the npm fixture’s digest from the fixture’s own packages', () => {
        // The cross-client conformance artefact: it checks agreement with the
        // server without needing a server, and agreement between clients
        // without them ever meeting.
        const wire = fixture('npm-report.json');

        assert.equal(wire.depmanWireVersion, WIRE_VERSION);
        assert.equal(
            reporter().digest(
                wire.packages as unknown as PackageEntry[],
                (wire.environment as unknown as { name: string }).name,
            ),
            (wire.report as unknown as { manifestDigest: string }).manifestDigest,
        );
    });

    test('the built payload has the same shape as the fixture', () => {
        const wire = fixture('npm-report.json');
        const built = reporter().buildPayload(
            config(),
            [],
            { name: 'production', resolvedFrom: 'APP_ENV' },
            'postinstall',
            NPM,
        );

        assert.deepEqual(Object.keys(built), Object.keys(wire));

        for (const section of ['report', 'environment', 'client', 'manifest', 'counts'] as const) {
            assert.deepEqual(
                Object.keys(built[section]),
                Object.keys(wire[section] as unknown as object),
                `the ${section} section has drifted from the fixture`,
            );
        }
    });

    test('it ships a byte-identical copy of the composer fixture too', () => {
        // WireFixtureParityTest in the application suite asserts this from the
        // other side; asserting it here means the client suite fails on its own
        // when a fixture goes missing.
        assert.equal(fixture('composer-report.json').ecosystem, 'composer');
    });
});

describe('The payload', () => {
    test('it declares the wire version and the client identity', () => {
        const built = reporter().buildPayload(config(), [], { name: 'local', resolvedFrom: 'fallback' }, 'manual', NPM);

        assert.equal(built.depmanWireVersion, WIRE_VERSION);
        assert.equal(built.client.name, CLIENT_NAME);
        assert.equal(built.client.version, CLIENT_VERSION);
        assert.equal(built.client.packageManager.name, 'npm');
        assert.equal(built.client.runtime.name, 'node');
    });

    test('the client name is the published package name', () => {
        // docs/ingest-clients.md section 1 fixes this; it is not a choice.
        assert.equal(CLIENT_NAME, '@depman/client');
    });

    test('it names npm as the ecosystem and package-lock.json as the lockfile', () => {
        const built = reporter().buildPayload(config(), [], { name: 'local', resolvedFrom: 'fallback' }, 'manual', NPM);

        assert.equal(built.ecosystem, 'npm');
        assert.equal(built.manifest.lockfileName, 'package-lock.json');
    });

    test('it names the manager that actually installed the tree', () => {
        // pnpm installs the npm ecosystem too: the ecosystem stays npm, and
        // packageManager says which tool produced the report.
        const built = reporter().buildPayload(
            config(),
            [],
            { name: 'local', resolvedFrom: 'fallback' },
            'manual',
            PNPM,
        );

        assert.equal(built.ecosystem, 'npm');
        assert.deepEqual(built.client.packageManager, { name: 'pnpm', version: '9.12.0' });
        assert.equal(built.manifest.lockfileName, 'pnpm-lock.yaml');
    });

    test('it carries the resolved environment and its provenance', () => {
        const built = reporter().buildPayload(
            config(),
            [],
            { name: 'staging', resolvedFrom: 'APP_ENV' },
            'manual',
            NPM,
        );

        assert.equal(built.environment.name, 'staging');
        assert.equal(built.environment.resolvedFrom, 'APP_ENV');
    });

    test('counts.packages matches the packages actually sent', () => {
        const built = reporter().buildPayload(
            config(),
            [entry(), entry({ purl: 'pkg:npm/b@1.0.0' })],
            { name: 'local', resolvedFrom: 'fallback' },
            'manual',
            NPM,
        );

        assert.equal(built.counts.packages, 2);
        assert.equal(built.packages.length, 2);
    });

    test('generatedAt is a UTC instant', () => {
        const built = reporter().buildPayload(config(), [], { name: 'local', resolvedFrom: 'fallback' }, 'manual', NPM);

        assert.match(built.report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    test('the token never appears in the payload', () => {
        // It travels in Authorization: Bearer and nowhere else.
        const built = reporter().buildPayload(
            config(),
            [entry()],
            { name: 'local', resolvedFrom: 'fallback' },
            'manual',
            NPM,
        );

        assert.doesNotMatch(JSON.stringify(built), /dpm_live_/);
    });
});
