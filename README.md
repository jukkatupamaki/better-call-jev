# better-call-jev

[![test](https://github.com/jukkatupamaki/better-call-jev/actions/workflows/test.yml/badge.svg)](https://github.com/jukkatupamaki/better-call-jev/actions/workflows/test.yml)

Zero-dependency client for [TypeSafe AI's Jev](https://typesafe.ai) evaluation model, packaged as a Claude Code plugin.

- `skills/jev/SKILL.md` describes the skill to Claude and documents the CLI and module API.
- `skills/jev/scripts/jev.mjs` is the client: a CLI and an ES module. Node 18+, no npm install.
- `.claude-plugin/` holds the plugin manifest and a single-plugin marketplace, so this repo installs directly.
- `hooks/` holds a silent SessionStart hook that exports the session id as `JEV_SESSION_ID`, for Claude Code versions that do not set `CLAUDE_CODE_SESSION_ID` in Bash. Logged calls are grouped by session. It adds nothing to Claude's context.

Claude uses Jev when you ask it to: "ask jev whether this is safe", "use bcj for the judgement calls in this task", or `/jev`. To make that the default, say so in your `CLAUDE.md`, for example "Run judgement calls through Jev (better-call-jev)".

## Setup

Set `JEV_API_KEY` in your environment. Never commit it. Options:

- shell profile: `export JEV_API_KEY=...`
- per project, gitignored: `.claude/settings.local.json` with `{ "env": { "JEV_API_KEY": "..." } }`
- for the quick check below: a gitignored `.env` file (see `.env.example`)

Decision thresholds: every boolean answer from the CLI starts with a verdict (`yes`, `no`, `undecided`) computed from two cut-offs that default to 0.8 and 0.2. Move them for your own risk tolerance with `JEV_THRESHOLD_HIGH` and `JEV_THRESHOLD_LOW` in the same places as the key, or per call with `--thresholds 0.9,0.1`.

Provider note: requests are currently served through Vercel AI Gateway, so the key is an AI Gateway key from your Vercel account. Nothing in the CLI, module API, or output depends on this, and the transport can change without affecting callers.

## Data handling

Every Jev call sends its `state`, `instructions` and `criteria` to Vercel AI Gateway and TypeSafe AI. Treat anything in a request as shared with them and possibly kept: check their terms, which may give them rights to use what you send. `--no-retain` asks the gateway for zero data retention, but it is best effort and not a privacy guarantee.

What the plugin does about it:

- **Instructions.** The skill tells the agent never to send secrets, credentials, personal data, customer data, or anything you called confidential. The agent masks such values or decides without Jev. Jev is never to be used to scan for secrets or personal data.
- **A client-side block.** Before sending, the client scans the whole request for private keys, common API key and token formats (AWS, GitHub, Slack, OpenAI and Anthropic style, Stripe, Google), JWTs, `password=`/`secret=` style assignments, and card numbers. On a match it sends nothing and fails with error code `sensitive`, naming the kind and location but not the value. This is a backstop for obvious credentials. It does not detect personal data or business secrets. `JEV_ALLOW_SENSITIVE=1` turns it off; agents are told never to set it.
- **A local log only.** The call log (see `skills/jev-stats`) stays on your machine. Blocked requests are logged without their content. `JEV_LOG=meta` stops storing request state, `JEV_LOG=off` stops logging.

How much of your work passes through Jev depends on how often you ask Claude to use it. A standing instruction in `CLAUDE.md` sends a lot more than an occasional "ask jev".

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
env $(cat .env) node skills/jev/scripts/jev.mjs --state "Card charged twice" --bool "refund=Is the customer asking for a refund?"
```

```
refund undecided .31
```

## Request and answer format

The CLI reads and prints a compact line format instead of JSON, because JSON spends an agent's tokens on quotes, braces, and repeated field names. Requests on stdin:

```
@ticket
Card charged twice, please sort it out.
?refund bool Is `ticket` asking for a refund?
?team choice Which team owns `ticket`?
 billing: charges, invoices, refunds
 other: anything else
?urgency score How urgent is `ticket`?
 can wait | this week | today | now
```

Answers, one line per question:

```
refund undecided .55
team billing .93 c=.87 | other .07
urgency 2/3 .61 c=.52 e=1.79 | 1:.3 3:.09
```

`@key` starts a state field whose body runs to the next `@` or `?` line; lines of evidence starting with `@` or `?` are written doubled. A score shows the likeliest rung as `rung/max`, numbered from 0, and `e=` the expected rung. Stdin starting with `{` is still read as a JSON request, and `--json` prints JSON answers. `skills/jev/SKILL.md` has the full reference.

## Tests

```bash
node --test test/*.test.mjs
```

No dependencies, no network, no key needed. The suite stubs `fetch` for transport and provider logic, runs a local HTTP server for timeout and CLI cases, and spawns the real script, including through a symlink, to cover entrypoint detection, argument parsing, stdin modes, the compact format, output shape, and exit codes. The `test/` folder is not part of the shipped skill.

The live conformance check is separate and needs a real key:

```bash
JEV_API_KEY=... node skills/jev/scripts/check-provider.mjs
```

## Adding a gateway

Only Vercel AI Gateway is implemented, but the script is built so another gateway is one table entry with no changes to the CLI, module API, output, or docs.

1. Add an entry to `PROVIDERS` in `skills/jev/scripts/jev.mjs`. The contract is documented in the comment above the table. In short: `label`, `keyHelp`, `keyEnvFallbacks`, `requiredEnv` (extra config such as an account id, each with a help string), `supportsNoRetain`, `endpoint(env)`, `buildRequest`, `parseResponse`, and optionally `extractError` for gateways that return errors with HTTP 200.
2. Translate to and from the canonical shape inside the entry. Callers must always see `type: "boolean"` with `probability`, `choice` with `choice`, `probabilities`, `confidence`, and `score` with `score` (the expected rung, a float), `probabilities` keyed by rung index, `confidence`. If the gateway calls booleans `noul` or wraps the body in `result`, undo that in `parseResponse`.
3. Run the conformance check against a live key for that gateway:

   ```bash
   JEV_API_KEY=... node skills/jev/scripts/check-provider.mjs <name>
   ```

   It sends one request with all three question types and fails on any deviation from the canonical shape.

4. Bump the plugin version. The provider list in `--help` and in error messages updates itself.

Cloudflare Workers AI is the likely next entry. Its differences are known: `noul` naming, a `result` envelope, an account id in the URL, snake_case usage, no request id, no retention option.

## Releasing

Bump `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, commit, and tag. Version-pinned installs only update when the string changes.

## Website

The landing page at [bettercalljev.com](https://bettercalljev.com) is the static `site/` folder, deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that touches it.

`site/llms-full.txt` is generated from this README and `skills/jev/SKILL.md`. After editing either, run `node tools/llms-full.mjs`; CI fails if it is out of date.

The social card `site/og.png` is rendered from `tools/og.html`, which mirrors the hero. Edit the HTML and regenerate it with `node tools/og.mjs` (needs `playwright` and a Chromium; set `CHROMIUM` to reuse one you already have). Keep its terminal transcript in step with the hero animation.
