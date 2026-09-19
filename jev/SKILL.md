---
name: jev
description: Ask TypeSafe AI's Jev evaluation model fast, typed questions about any text or JSON state. Use when you need a yes/no probability, a classification/routing choice, or a rubric score over some input (a diff, a log, a ticket, a transcript, an agent output) instead of free-form LLM text. Triggers on "classify", "route", "score", "grade", "is this X?", "judge", "verify", "LLM-as-judge", "jev".
---

# Jev evaluation

Jev is an *evaluation* model, not a chat model. It takes a `state` (text, object, or array) and one or more typed questions, and returns calibrated probabilities. It is cheap (input tokens only) and fast (a few hundred ms), so use it liberally for decisions in code and in your own workflow. Context window is 32k tokens.

## What a typed question is

A typed question declares the shape of its answer up front, so code can consume the result directly instead of parsing prose. You give a `type`, plain-language `instructions`, and optionally `criteria`; the answer comes back as validated data of that type. Jev does not generate tokens. It evaluates every question in parallel against the `state` and returns a probability distribution over the declared answers, which is why each answer carries calibrated uncertainty. Think of `state` as the evidence, a question as a function signature over that evidence, and the answer as a value of the declared return type with a probability attached. Jev cannot explain itself or return anything outside the declared types.

## Question types

| Type | You give | You get back |
|---|---|---|
| `boolean` | `instructions`, optional `criteria: {true, false}` | `probability` 0..1 |
| `choice` | `instructions`, `criteria: {name: description}` | `choice`, `probabilities` per option, `confidence` |
| `score` | `instructions`, `criteria: [lowest, ..., highest]` | `score` in 0..(rungs-1), `probabilities` keyed by rung index `"0".."n-1"`, `confidence` |

Several questions can go in one request against the same state.

## Setup

- Node 18+.
- `JEV_API_KEY` in the environment. If it only lives in a `.env` file, run `env $(cat .env) node ...` in one command.
- The script is `scripts/jev.mjs` next to this file. Resolve it against this skill's directory, for example `~/.claude/skills/jev/scripts/jev.mjs`.
- `--help` prints the full flag reference.

## CLI

```bash
# yes/no
node scripts/jev.mjs --state "Build failed with exit code 1" --bool "Did the build succeed?"
# → { "q1": { "type": "boolean", "probability": 0.02 } }

# named keys, several questions at once
node scripts/jev.mjs --state "Card charged twice, want refund" \
  --bool   "refund=Is the customer asking for money back?" \
  --choice "route=Route this ticket" --options "billing=charges,shipping=delivery,technical=bugs" \
  --score  "urgency=How urgent?" --scale "low,medium,high"

# state from a file (paths ending in .json are parsed as structured state), inline JSON, or stdin
node scripts/jev.mjs --state-file ticket.json --bool "Is this spam?"
node scripts/jev.mjs --state-json '{"exitCode":1}' --bool "Did it pass?"
git diff | node scripts/jev.mjs --score "Risk of this change" --scale "trivial,low,moderate,high,critical"

# full request JSON on stdin (most flexible; use when questions need criteria the flags cannot express)
echo '{"state": "...", "questions": {"ok": {"type": "boolean", "instructions": "...", "criteria": {"true": "...", "false": "..."}}}}' | node scripts/jev.mjs

# --questions merges a raw questions object with flag-built ones
node scripts/jev.mjs --state "..." --questions '{"ok": {"type": "boolean", "instructions": "..."}}'
```

Rules:

- Give exactly one of `--state`, `--state-file`, `--state-json`. With none, stdin is used: as the state text when question flags are present, otherwise as a full request `{state, questions}`.
- Question keys default to `q1`, `q2`, ... unless written as `key=instructions`.
- `--options` and `--scale` are comma-separated. `--options` takes `name=description` pairs, or plain names. `--scale` takes labels only, lowest to highest. Commas inside a description are not supported; use `--questions` or stdin JSON instead.
- `--verbose` prints `{ answers, usage: { inputTokens, outputTokens }, requestId }` instead of just `answers`.
- `--no-retain` asks the service not to retain the input (best effort).
- Output is JSON on stdout. Errors go to stderr with exit code 1, prefixed with a code: `auth`, `bad_request`, `rate_limited`, `unavailable`, `unknown`.

## As a module

```js
import { evaluate, ask, choose, score, JevError } from './scripts/jev.mjs';

await ask(state, instructions, criteria?);          // → probability (number)
await choose(state, instructions, { name: desc }); // → { choice, probabilities, confidence }
await score(state, instructions, [low, ..., high]); // → { score, probabilities, confidence }
await evaluate({ state, questions, retain? });      // → { answers, usage, requestId }
```

All functions throw `JevError` with `.code` (see the codes above) and `.cause` holding upstream detail.

## Writing good questions

- Put the *thing being judged* in `state`, and the *question* in `instructions`. Do not paste the state into the instructions.
- For `boolean`, add `criteria: {true: ..., false: ...}` whenever the boundary is fuzzy.
- For `choice`, describe each option; the descriptions are what the model matches against. Include an `other` option when the input may not fit.
- For `score`, order rungs lowest to highest and label each one. The `score` is a float across rungs, so a 4-rung scale yields 0..3.
- Batch related questions into one call; they share the state and one round trip.
- Treat `probability` < 0.2 or > 0.8 as decisive; in between, ask a follow-up or fall back to a chat model. Tune thresholds on your own labeled data.
- Trim large logs or diffs to the relevant part to stay under the 32k context window.
