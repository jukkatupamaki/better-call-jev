# better-call-jev

Zero-dependency client for [TypeSafe AI's Jev](https://typesafe.ai) evaluation model, packaged as a Claude Code plugin.

- `skills/jev/SKILL.md` describes the skill to Claude and documents the CLI and module API.
- `skills/jev/scripts/jev.mjs` is the client: a CLI and an ES module. Node 18+, no npm install.
- `.claude-plugin/` holds the plugin manifest and a single-plugin marketplace, so this repo installs directly.
- `hooks/` holds a SessionStart hook that loads `hooks/protocol.md` into every session. With the plugin installed, Claude delegates all judgment calls to Jev rather than deciding by intuition. Remove or edit the hook if you want the skill available without the always-on rule.

## Setup

Set `JEV_API_KEY` in your environment. Never commit it. Options:

- shell profile: `export JEV_API_KEY=...`
- per project, gitignored: `.claude/settings.local.json` with `{ "env": { "JEV_API_KEY": "..." } }`
- for the quick check below: a gitignored `.env` file (see `.env.example`)

Provider note: requests are currently served through Vercel AI Gateway, so the key is an AI Gateway key from your Vercel account. Nothing in the CLI, module API, or output depends on this, and the transport can change without affecting callers.

## Install

**As a plugin** (recommended):

```
/plugin marketplace add jukkatupamaki/better-call-jev
/plugin install better-call-jev@better-call-jev
```

Add `--scope project` to record it in the consuming repo's `.claude/settings.json`. Update with `/plugin update better-call-jev@better-call-jev`. The skill is invoked as `/better-call-jev:jev`, or `/jev` when no other skill claims the name.

**Local development** of this repo:

```
claude --plugin-dir /path/to/this/repo
```

**Symlink** into your personal skills, no plugin machinery:

```bash
ln -s "$(pwd)/skills/jev" ~/.claude/skills/jev
```

**Vendor** into a project so teammates get it on clone:

```bash
cp -r skills/jev /path/to/project/.claude/skills/jev
```

## Quick check

```bash
env $(cat .env) node skills/jev/scripts/jev.mjs --state "Card charged twice" --bool "Is the customer asking for a refund?"
```

## Tests

```bash
node --test 'test/*.test.mjs'
```

No dependencies, no network, no key needed. The suite stubs `fetch` for transport and provider logic, runs a local HTTP server for timeout and CLI cases, and spawns the real script, including through a symlink, to cover entrypoint detection, argument parsing, stdin modes, output shape, and exit codes. The `test/` folder is not part of the shipped skill.

The live conformance check is separate and needs a real key:

```bash
JEV_API_KEY=... node skills/jev/scripts/check-provider.mjs
```

## Adding a gateway

Only Vercel AI Gateway is implemented, but the script is built so another gateway is one table entry with no changes to the CLI, module API, output, or docs.

1. Add an entry to `PROVIDERS` in `skills/jev/scripts/jev.mjs`. The contract is documented in the comment above the table. In short: `label`, `keyHelp`, `keyEnvFallbacks`, `requiredEnv` (extra config such as an account id, each with a help string), `supportsNoRetain`, `endpoint(env)`, `buildRequest`, `parseResponse`, and optionally `extractError` for gateways that return errors with HTTP 200.
2. Translate to and from the canonical shape inside the entry. Callers must always see `type: "boolean"` with `probability`, `choice` with `choice`, `probabilities`, `confidence`, and `score` with `score`, `probabilities` keyed by rung index, `confidence`. If the gateway calls booleans `noul` or wraps the body in `result`, undo that in `parseResponse`.
3. Run the conformance check against a live key for that gateway:

   ```bash
   JEV_API_KEY=... node skills/jev/scripts/check-provider.mjs <name>
   ```

   It sends one request with all three question types and fails on any deviation from the canonical shape.

4. Bump the plugin version. The provider list in `--help` and in error messages updates itself.

Cloudflare Workers AI is the likely next entry. Its differences are known: `noul` naming, a `result` envelope, an account id in the URL, snake_case usage, no request id, no retention option.

## Releasing

Bump `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, commit, and tag. Version-pinned installs only update when the string changes.
