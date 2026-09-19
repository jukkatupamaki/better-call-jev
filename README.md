# jev

Zero-dependency client for [TypeSafe AI's Jev](https://typesafe.ai) evaluation model, packaged as a Claude Code skill.

- `jev/SKILL.md` describes the skill to Claude and documents the CLI and module API.
- `jev/scripts/jev.mjs` is the client: a CLI and an ES module. Node 18+, no npm install.

## Setup

Set `JEV_API_KEY` in your environment. Never commit it; a gitignored `.env` file works.

Provider note: requests are currently served through Vercel AI Gateway, so the key is an AI Gateway key from your Vercel account. Nothing in the CLI, module API, or output depends on this, and the transport can change without affecting callers.

## Use in other projects

```bash
# global: available in every project
ln -s "$(pwd)/jev" ~/.claude/skills/jev

# per project
mkdir -p /path/to/project/.claude/skills
ln -s "$(pwd)/jev" /path/to/project/.claude/skills/jev
```

Copy instead of symlink if the project should vendor its own copy. Then `/jev` in Claude Code, or just ask it to classify, route, or score something.

## Quick check

```bash
env $(cat .env) node jev/scripts/jev.mjs --state "Card charged twice" --bool "Is the customer asking for a refund?"
```
