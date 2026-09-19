# jev

Zero-dependency client for [TypeSafe AI's Jev](https://typesafe.ai) evaluation model, packaged as a Claude Code plugin.

- `skills/jev/SKILL.md` describes the skill to Claude and documents the CLI and module API.
- `skills/jev/scripts/jev.mjs` is the client: a CLI and an ES module. Node 18+, no npm install.
- `.claude-plugin/` holds the plugin manifest and a single-plugin marketplace, so this repo installs directly.

## Setup

Set `JEV_API_KEY` in your environment. Never commit it. Options:

- shell profile: `export JEV_API_KEY=...`
- per project, gitignored: `.claude/settings.local.json` with `{ "env": { "JEV_API_KEY": "..." } }`
- for the quick check below: a gitignored `.env` file (see `.env.example`)

Provider note: requests are currently served through Vercel AI Gateway, so the key is an AI Gateway key from your Vercel account. Nothing in the CLI, module API, or output depends on this, and the transport can change without affecting callers.

## Install

**As a plugin** (recommended; works for you and for others once this repo is on GitHub):

```
/plugin marketplace add <github-user>/<repo>
/plugin install jev@jev
```

Add `--scope project` to record it in the consuming repo's `.claude/settings.json`. Update with `/plugin update jev@jev`. The skill is invoked as `/jev:jev`, or `/jev` when no other skill claims the name.

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

## Releasing

Bump `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, commit, and tag. Version-pinned installs only update when the string changes.
