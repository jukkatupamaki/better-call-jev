# jev

Zero-dependency wrapper for [TypeSafe AI's Jev](https://vercel.com/ai-gateway/models/jev) evaluation model on Vercel AI Gateway, packaged as a Claude Code skill.

- `jev/SKILL.md` describes the skill to Claude.
- `jev/scripts/jev.mjs` is the wrapper: a CLI and an ES module. Node 18+, no npm install.

## Use in other projects

Set `AI_GATEWAY_API_KEY` (or `VERCEL_AI_GATEWAY_KEY`) in the environment, then install the skill either globally or per project:

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
export $(cat .env)
node jev/scripts/jev.mjs --state "Card charged twice" --bool "Is the customer asking for a refund?"
```

See `jev/SKILL.md` for the full CLI and module API.
