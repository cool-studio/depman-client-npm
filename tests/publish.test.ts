import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The publish workflow, which runs in the mirror and not here.
 *
 * Every assertion below pins something that fails *invisibly*. The workflow
 * only ever runs in cool-studio/depman-client-npm, on a version tag, so a
 * mistake in it is discovered during a release rather than on the branch that
 * caused it -- and the worst of these mistakes do not fail the release at all.
 * They release the wrong thing successfully.
 *
 * See docs/ingest-clients.md section 14 and ADR-0040.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The path is part of the contract, not an implementation detail: see below.
const WORKFLOW = join(ROOT, '.github', 'workflows', 'publish.yml');

const workflow = (): string => readFileSync(WORKFLOW, 'utf8');

describe('the publish workflow', () => {
    test('it is at the path the trusted publisher names', () => {
        // npm's trusted publisher configuration identifies this workflow by
        // *filename*. Renaming or moving it does not fail a check anywhere --
        // it makes npm reject the OIDC exchange at release time, with an error
        // that names the workflow it expected and not the one that ran.
        assert.ok(
            existsSync(WORKFLOW),
            'Expected .github/workflows/publish.yml. The trusted publisher on npmjs.com names this ' +
                'filename, so moving it silently breaks releasing -- update it there first.',
        );
    });

    test('it requests the OIDC token trusted publishing runs on', () => {
        // Without `id-token: write` there is no OIDC token to exchange, and
        // there is no token in this repository to fall back to.
        assert.match(workflow(), /^\s*id-token:\s*write\s*$/m);
    });

    test('it stages the release rather than publishing it', () => {
        // The approval gate is the point (ADR-0040). A staged version is
        // uploaded and inspectable but installable by nobody until a maintainer
        // approves it with 2FA, so compromising this workflow -- or any of the
        // toolchain it runs -- cannot on its own put code into a consumer's
        // postinstall hook.
        //
        // `npm publish` here would work perfectly, release faster, and remove
        // that gate. Nothing else would notice, which is why this is asserted
        // rather than left as a convention.
        assert.match(workflow(), /npm stage publish --access public/);
        assert.doesNotMatch(
            workflow(),
            // A command, not a mention: comments about npm publishing start
            // with a hash and are not what this is guarding against.
            /^\s*npm publish\b/m,
            'The workflow must stage for approval, never publish directly -- ADR-0040.',
        );
    });

    test('it stages the scoped package publicly', () => {
        // A scoped package defaults to `restricted`. Without this the release
        // is approved successfully and installs for nobody, which looks exactly
        // like a published client until a consumer tries to install it.
        assert.match(workflow(), /--access public/);
    });

    test('it carries no long-lived npm credential', () => {
        // The other half of ADR-0040: the mirror is public and force-pushed by
        // an automated job, so it is the last place that should hold a
        // credential which can write to the @depman scope. A reintroduced token
        // would work, which is exactly why nothing else would catch it.
        assert.doesNotMatch(workflow(), /NODE_AUTH_TOKEN/);
        assert.doesNotMatch(workflow(), /NPM_TOKEN/);
        assert.doesNotMatch(workflow(), /secrets\./);
    });
});
