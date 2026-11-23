import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The artefact a consumer installs, installed the way a consumer installs it.
 *
 * Every other test in this suite runs inside the package directory, and in
 * that tree `@depman/client` is not an installed dependency -- it is the tree.
 * Nothing there resolves the package by name, which is how 0.1.0 to 0.1.3
 * shipped with no entry point while every check stayed green: Node could not
 * resolve the package, and `bud build` died in every project that installed it
 * (ADR-0048).
 *
 * So this packs the tarball npm would publish, installs it into a scratch
 * project outside the repository with no network, and asserts what a consumer
 * depends on: the package resolves and loads without side effects, and the bin
 * is linked and runs. It asserts behaviour, never a manifest field --
 * package.test.ts pins fields, and no assertion about the fields that are
 * present can see one that is absent (ADR-0055).
 *
 * It proves the package installs and loads. It does **not** prove the client
 * reports a consumer's tree correctly; that is the live-resolve item in
 * docs/ingest-clients.md, and this does not close it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** What the tarball holds, at its top level, and nothing else. */
const SHIPPED = ['LICENSE', 'README.md', 'dist', 'package.json'];

let scratch = '';
let project = '';
let packed: string[] = [];

/**
 * Run a command with npm's own run-time variables removed.
 *
 * `npm run smoke` exports `npm_config_*` and `npm_package_*` describing *this*
 * package; inherited, they would aim the scratch install back at the source.
 */
function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
    // INIT_CWD too: npm sets it to where `npm run` started, and the client's
    // projectRoot() prefers it to the working directory -- so a leaked one sends
    // `depman doctor` in the scratch project to read the source package instead.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && key !== 'INIT_CWD'),
    );

    return spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        // npm and the linked bin are .cmd shims on Windows, which only a shell runs.
        shell: process.platform === 'win32',
    });
}

function explain(result: SpawnSyncReturns<string>): string {
    return `exit ${String(result.status)}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`;
}

describe('the packed artefact, installed into a scratch project', () => {
    before(() => {
        // os.tmpdir(), never a directory inside the repository: npm resolves by
        // walking up, would find our own node_modules, and the test would pass
        // for the wrong reason.
        scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depman-npm-smoke-')));
        project = join(scratch, 'project');
        mkdirSync(project);

        // --ignore-scripts because `npm run smoke` has just built dist/, and
        // `prepare` would only build it again -- writing to stdout, into the
        // JSON this reads.
        const pack = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], ROOT);
        assert.equal(pack.status, 0, explain(pack));

        // npm 10 and 11 print an array of summaries; npm 12 prints an object
        // keyed by package name. The Node 18 floor ships the first, Node 24
        // the second, and CI runs both.
        type Summary = { filename: string; files: { path: string }[] };
        const parsed = JSON.parse(pack.stdout) as Summary[] | Record<string, Summary>;
        const summary = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]) as Summary;
        packed = summary.files.map((file) => file.path);

        writeFileSync(
            join(project, 'package.json'),
            `${JSON.stringify({ name: 'depman-smoke-project', version: '0.0.0', private: true }, null, 4)}\n`,
        );

        // --offline: the client has no runtime dependency, so an install that
        // needs the registry is a bug -- and a release gate that needs the
        // network fails on a bad afternoon.
        const install = run(
            'npm',
            ['install', join(scratch, summary.filename), '--offline', '--no-audit', '--no-fund'],
            project,
        );
        assert.equal(install.status, 0, explain(install));
    });

    after(() => {
        if (scratch !== '') {
            rmSync(scratch, { recursive: true, force: true });
        }
    });

    test('the tarball holds what a consumer needs and nothing else', () => {
        // Moved here from the release checklist, where a human read it. The
        // contents were never what broke 0.1.0 -- but `files` and npm's
        // force-includes are what shape the artefact, and a wrong `files`
        // entry is the same class of bug as a missing `main`.
        const top = [...new Set(packed.map((path) => path.split('/')[0] ?? path))].sort();

        assert.deepEqual(top, SHIPPED);
        assert.ok(
            packed.filter((path) => path.startsWith('dist/')).every((path) => path.startsWith('dist/src/')),
            `only dist/src ships; got ${packed.join(', ')}`,
        );
        assert.ok(packed.includes('dist/src/index.js'), 'the entry point ships');
        assert.ok(packed.includes('dist/src/cli.js'), 'the bin ships');
    });

    test('the package resolves by name and imports without side effects', () => {
        // This is the whole of the 0.1.x bug: a bare-specifier import from a
        // project that depends on us. Resolving through require.resolve as
        // well covers tooling that enumerates dependencies the CommonJS way.
        //
        // The script prints exactly one line and nothing else may. If `main`
        // ever pointed at cli.js, the CLI would run on import -- print its
        // usage, set an exit code, maybe write a spool -- and every one of
        // those breaks an assertion below.
        const script = `
            import { readdirSync } from 'node:fs';
            import { createRequire } from 'node:module';
            const files = readdirSync('.').sort();
            const resolved = createRequire(process.cwd() + '/').resolve('@depman/client');
            const entry = await import('@depman/client');
            await new Promise((done) => setTimeout(done, 100));
            process.stdout.write(JSON.stringify({
                resolved,
                exitCode: process.exitCode ?? null,
                version: entry.CLIENT_VERSION,
                reporter: typeof entry.Reporter,
                unchanged: JSON.stringify(readdirSync('.').sort()) === JSON.stringify(files),
            }) + '\\n');
        `;

        const result = run(process.execPath, ['--input-type=module', '--eval', script, 'report'], project);

        assert.equal(result.status, 0, explain(result));
        assert.equal(result.stderr, '', explain(result));

        const lines = result.stdout.trim().split('\n');
        assert.equal(lines.length, 1, explain(result));

        const loaded = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
        const installed = join(project, 'node_modules', '@depman', 'client') + sep;

        assert.ok(
            String(loaded.resolved).startsWith(installed),
            `resolved from the install: ${String(loaded.resolved)}`,
        );
        assert.equal(loaded.exitCode, null, 'importing the package set no exit code');
        assert.equal(typeof loaded.version, 'string');
        assert.equal(loaded.reporter, 'function');
        assert.equal(loaded.unchanged, true, 'importing the package wrote nothing');
    });

    test('the bin is linked and prints its usage', () => {
        const bin = join(project, 'node_modules', '.bin', 'depman');
        assert.ok(existsSync(process.platform === 'win32' ? `${bin}.cmd` : bin), 'npm linked the bin');

        const result = run(bin, [], project);

        assert.equal(result.status, 0, explain(result));
        assert.match(result.stdout, /depman report \[--fail-on-error\]/);
        assert.match(result.stdout, /depman doctor/);
    });

    test('doctor runs from the installed tree', () => {
        // doctor loads depman.json, resolves the environment and looks for a
        // token -- the whole configuration path -- and makes no request.
        writeFileSync(
            join(project, 'depman.json'),
            JSON.stringify({ configVersion: 1, endpoint: 'https://depman.invalid', project: 'smoke/project' }),
        );

        const result = run(join(project, 'node_modules', '.bin', 'depman'), ['doctor'], project);

        assert.equal(result.status, 0, explain(result));
        assert.match(result.stdout, /smoke\/project \(from depman\.json\)/);
    });
});
