---
name: jev
description: Ask TypeSafe AI's Jev evaluation model fast, typed questions about any text or JSON state via Vercel AI Gateway. Use when you need a yes/no probability, a classification/routing choice, or a rubric score over some input (a diff, a log, a ticket, a transcript, an agent output) instead of free-form LLM text. Triggers on "classify", "route", "score", "grade", "is this X?", "judge", "verify", "LLM-as-judge", "jev".
---

# Jev evaluation

Jev is an *evaluation* model, not a chat model. It takes a `state` (text, object, or array) and one or more typed questions, and returns calibrated probabilities. It is cheap (input tokens only, ~$0.04/M) and fast (~200 ms), so use it liberally for decisions in code and in your own workflow.

## What a typed question is

A typed question declares the shape of its answer up front, so code can consume the result directly instead of parsing prose. You give a `type`, plain-language `instructions`, and optionally `criteria`; the answer comes back as validated data of that type. Jev does not generate tokens. It evaluates every question in parallel against the `state` and returns a probability distribution over the declared answers, which is why each answer carries calibrated uncertainty. Think of `state` as the evidence, a question as a function signature over that evidence, and the answer as a value of the declared return type with a probability attached. Jev cannot explain itself or return anything outside the declared types.

Three question types:

| Type | Give | Get back |
|---|---|---|
| `boolean` | instructions (+ optional `criteria: {true, false}`) | `probability` 0..1 |
| `choice` | instructions + `criteria: {name: description}` | `choice` + per-option `probabilities` |
| `score` | instructions + `criteria: [low, ..., high]` | interpolated `score` + per-rung `probabilities` |

Several questions can go in one request against the same state.

## Setup

Requires Node 18+ and `AI_GATEWAY_API_KEY` (or `VERCEL_AI_GATEWAY_KEY`) in the environment. If it is only in a `.env` file, prefix the command with `export $(cat .env)` or `env $(cat .env)`.

Script path: `scripts/jev.mjs` relative to this skill directory. Run it with `node`.

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

# state from a file (JSON files become structured state) or stdin
node scripts/jev.mjs --state-file ticket.json --bool "Is this spam?"
git diff | node scripts/jev.mjs --score "Risk of this change" --scale "trivial,low,moderate,high,critical"

# full request JSON on stdin (most flexible)
echo '{"state": "...", "questions": {"ok": {"type": "boolean", "instructions": "..."}}}' | node scripts/jev.mjs

# --raw prints usage, cost and routing metadata; --zdr requests zero data retention
```

Output is the `answers` object as JSON on stdout. Errors go to stderr with exit code 1.

## As a module

```js
import { evaluate, ask, choose, score } from './scripts/jev.mjs';

await ask('Deploy finished, no errors', 'Did it succeed?');           // 0.98
await choose('Login button dead', 'Which team?', { billing: '...', technical: '...' }); // { choice, probabilities }
await score('PR adds tests+docs', 'Quality', ['poor', 'fair', 'good']); // { score, probabilities }
await evaluate({ state, questions, providerOptions });                  // full response
```

## Writing good questions

- Put the *thing being judged* in `state`, and the *question* in `instructions`. Do not paste the state into the instructions.
- For `boolean`, add `criteria: {true: ..., false: ...}` whenever the boundary is fuzzy.
- For `choice`, describe each option; the descriptions are what the model matches against. Include an `other` option when the input may not fit.
- For `score`, order rungs lowest to highest and label each one. The `score` is a float across rungs (e.g. 2.86 on a 0..3 scale).
- Batch related questions into one call; they share the state and one round trip.
- Treat `probability` < 0.2 or > 0.8 as decisive; in between, ask a follow-up or fall back to a chat model.
- Context window is 32k tokens. Trim large logs or diffs to the relevant part.
