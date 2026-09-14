import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_NAME, CLIENT_VERSION } from '../src/reporter.js';

/**
 * The manifest carries claims the rest of the package depends on.
 *
 * Each one here has a specific way of being quietly wrong: a second `bin`
 * breaks the documented invocation, a drifting `version` makes every report
 * lie about which build produced it, and a runtime dependency is a supply-chain
 * surface we promised consumers we would not add.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;

describe('package.json', () => {
    test('it declares exactly one bin, named depman', () => {
        // **The documented invocation depends on this.** Every snippet says
        // `npx @depman/client <command>`, which resolves the package and runs
        // its single bin; npx cannot choose for you once there are two, so a
        // second entry silently breaks the onboarding copy in docs/depman-json.md,
        // the README and the wizard.
        //
        // The scoped form is deliberate: `npx depman` would also work, but
        // `depman` unscoped is a real, unrelated package on the registry, and
        // npx falls back to fetching it when a name does not resolve locally.
        assert.deepEqual(manifest.bin, { depman: './dist/src/cli.js' });
    });

    test('the published name is the one the specification fixes', () => {
        // docs/ingest-clients.md section 1. It is also what the payload and the
        // User-Agent carry.
        assert.equal(manifest.name, '@depman/client');
        assert.equal(CLIENT_NAME, manifest.name);
    });

    test('the repository field names the mirror, and the bugs field does not', () => {
        // **The registry enforces the first half of this.** Provenance is
        // attested from the workflow run in the mirror, and npm validates
        // `repository.url` against the repository in the sigstore bundle --
        // an empty or monorepo-pointing value is a 422 on every `npm stage
        // publish`, discovered at release time and nowhere earlier. That is
        // how npm-client/v0.1.1 died: tagged, split, staged, and refused.
        //
        // `bugs` is the counterpart nothing enforces: the mirror has issues
        // disabled by design (ADR-0020), and without an explicit value npm
        // derives the Issues link from `repository` and sends people to a
        // dead tab. Reports belong on the monorepo, as the README says.
        assert.deepEqual(manifest.repository, {
            type: 'git',
            url: 'git+https://github.com/cool-studio/depman-client-npm.git',
        });
        assert.equal(manifest.bugs, 'https://github.com/cool-studio/depman/issues');
    });

    test('the manifest version and the reported version agree', () => {
        // npm publishes what package.json says; the payload reports
        // CLIENT_VERSION. If they diverge, "which build produced this report?"
        // has no answer. Both move in the commit that gets tagged.
        assert.equal(manifest.version, CLIENT_VERSION);
    });

    test('it has no runtime dependencies', () => {
        // This installs into everyone else's production tree, so a dependency
        // of ours becomes their supply-chain surface -- docs/ingest-clients.md
        // section 7.
        assert.deepEqual(manifest.dependencies, {});
    });

    test('the tarball ships built output and nothing else', () => {
        // Consumers get a prebuilt dist/, so no lifecycle script has to run on
        // their machine to make the bin work.
        assert.deepEqual(manifest.files, ['dist/src']);
    });

    test('the declared licence ships its text', () => {
        // ADR-0047: the clients are MIT; the application is not. A "license"
        // field is a claim about a file -- MIT requires its notice to travel
        // with copies, and npm force-includes LICENSE in the tarball whatever
        // `files` says, so the file existing here is what makes the claim true.
        assert.equal(manifest.license, 'MIT');
        assert.match(readFileSync(join(ROOT, 'LICENSE'), 'utf8'), /^MIT License/);
    });
});
