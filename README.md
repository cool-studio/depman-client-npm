# @depman/client

> **This repository is a read-only mirror.**
> The client is developed in [`cool-studio/depman`](https://github.com/cool-studio/depman) under
> `packages/npm-client`, and split out here so that npm can install it. **Open issues and pull
> requests there** — this repository is force-pushed from the monorepo and anything committed
> directly is overwritten without warning.

Reports the npm packages **actually installed** in a project to [DepMan](https://depman.io), which
matches them against published security advisories and raises a Finding when one of your
environments is running a vulnerable version.

It runs from your `postinstall` script, so the inventory stays true without anyone remembering to
update it.

Each transitive package is reported with the route back to the dependency **you** declared, so an
advisory against something you have never heard of still names the line in your `package.json` that
pulls it in. The routes come from the installer's own record of what it put on disk — npm's hidden
lockfile, or pnpm's virtual store — not what the project lockfile intended, and where they cannot
be worked out the client sends nothing rather than a guess.

## It will not break your build

That is the rule the rest of the design follows from. The hook catches every throwable and returns
normally; a missing config file, a missing token, an unreachable server, a rate limit and a timeout
are all ordinary states rather than failures; and the process exits `0` unless you explicitly ask
otherwise with `--fail-on-error`.

A dependency-inventory tool that fails installs gets removed, and then it protects nobody.

## Install

<!-- snippet:install-npm -->
```bash
npm install @depman/client
npx @depman/client install-hook     # patches package.json for you
```
<!-- /snippet -->

**`npx @depman/client`, not `npx depman`.** The installed command is `depman`, and `npx depman`
finds it — but npx falls back to the registry when a name does not resolve locally, and `depman`
unscoped is a real, unrelated package. Naming the scoped package means a failed install fetches
*this* client rather than somebody else's code.

Put it in `dependencies`, not `devDependencies`: production deploys run `npm ci --omit=dev`, and a
`postinstall` script pointing at a binary that was not installed fails the install. It has **zero
runtime dependencies** — node's own modules and nothing else.

Which produces:

<!-- snippet:hook-npm -->
```jsonc
{
  "dependencies": { "@depman/client": "^0.1" },
  "scripts": {
    "postinstall": "depman report --postinstall"
  }
}
```
<!-- /snippet -->

## Configure

`depman.json` in your project root. It is committed, and it holds **no secrets**:

<!-- snippet:depman-json -->
```jsonc
{
  "$schema": "https://schema.depman.io/depman.schema.v1.json",
  "configVersion": 1,
  "endpoint": "https://depman.acme-internal.com",
  "project": "acme/storefront",

  "environment": {
    "from": ["DEPMAN_ENV", "APP_ENV"],
    "fallback": "local",                                   // a laptop is not production
    "map": { "prod": "production", "stage": "staging" },
    "allowed": ["local", "ci", "staging", "production"]
  },

  "ecosystems": "auto",
  "include": { "dev": true, "optional": true },

  "failOnError": false,                                    // never break composer install
  "timeoutMs": 10000,
  "offline": { "mode": "spool", "spoolDir": ".depman/spool" },
  "logLevel": "warn"
}
```
<!-- /snippet -->

Every setting resolves in the same order: **your project's `.env`, then the process environment,
then `depman.json`, then the built-in default.** `.env` comes first because the hook fires during
`npm install`, when nothing has loaded it into the environment yet.

## The token

Never in `depman.json` — that file is committed, and a token in it is already leaked. The client
refuses one loudly if it finds it. It is read from, first match winning:

1. `DEPMAN_TOKEN` in your project's `.env`
2. `DEPMAN_TOKEN` in the process environment
3. `DEPMAN_TOKEN_FILE`, pointing at a file — for Docker and Kubernetes secret mounts
4. `~/.depman/credentials`, JSON keyed by endpoint host

No token at all is a **skip, not an error**: the normal state for somebody who just cloned your
repository.

## Commands

| Command | Does |
|---|---|
| `npx @depman/client report [--fail-on-error]` | Report the installed tree now |
| `npx @depman/client push [--fail-on-error]` | Send everything left in the offline spool |
| `npx @depman/client doctor` | Print the resolved configuration and where each value came from |
| `npx @depman/client install-hook` | Add the hook to `postinstall` |

`doctor` is the first thing to run when something is not reporting. It prints the source of every
setting and **which of the four mechanisms supplied the token** — never the value:

```
Project:      acme/storefront
Endpoint:     https://depman.acme-internal.com
Environment:  production (from APP_ENV)
Token:        found via .env
Include dev:  yes
Include opt:  yes
```

## In CI

`npm install --ignore-scripts` is standard practice in security-conscious CI and skips the hook
entirely, so a dedicated step is the reliable path:

<!-- snippet:ci-npm -->
```yaml
# GitHub Actions
- name: Report dependencies to DepMan
  run: npx @depman/client report
  env:
    DEPMAN_TOKEN: ${{ secrets.DEPMAN_TOKEN }}
    DEPMAN_ENV: production
```
<!-- /snippet -->

### Gating a build

The **only** mode that may fail a build. It is opt-in, and it belongs in its own step — never in
`postinstall`:

```bash
npx @depman/client report --wait --fail-on=high
```

It waits for DepMan to scan the report, then exits `1` if any open finding in that environment is
at the threshold or worse. It **fails closed**: if it cannot get an answer — the wait ran out, the
poll was refused, the report was never accepted — it exits `2` rather than passing. A gate that
goes green over an unanswered question is worse than no gate.

`<severity>` is one of `critical`, `high`, `medium`, `low`, `unknown`.

## Offline

A report that cannot be delivered is written to `.depman/spool`, capped at 20 files and discarding
oldest first. Add `.depman/` to `.gitignore` — the client warns if you have not. `npx @depman/client push`
drains it and deletes only what the server accepted.

## What it reads

What the installer itself wrote to describe what is on disk — never your project lockfile, which
is an intention, and the two disagree exactly when it matters:

- **npm**: `node_modules/.package-lock.json`, the hidden lockfile.
- **pnpm**: the virtual store under `node_modules/.pnpm` — each instance's own installed
  `package.json` and its symlink farm, which is pnpm's record of the graph. No YAML is parsed.

**Trees installed by npm and by pnpm's default isolated linker are resolved.** Yarn and Bun install
the same ecosystem but leave nothing on disk that can be read without executing project code or
guessing at scopes, so the client refuses them loudly, by name — as it does pnpm's hoisted linker.
Use the CI step or the HTTP contract for those.

## Requirements

Node `>=18`. No runtime dependencies.

## Licence

MIT.
