---
name: jev
description: Fast, calibrated second opinion for judgment calls that come up while coding. Use it as part of your own reasoning whenever you are about to decide something about code by intuition: is this diff risky, does this change satisfy the request, is this test failure caused by my change, which of these files is the right place, is this error message actionable, does this PR description match the diff, does this function need a test, is this issue a bug or a feature request. Also for grading or verifying outputs from subagents, reviewing candidate commit messages, and triaging logs, test output, or issues. Jev returns a probability or a choice, not text, in a few hundred ms. Triggers on "should I", "is this safe", "which one", "does this match", "verify", "grade", "score", "classify", "route", "triage", "judge", "jev".
---

# Jev: typed judgment calls while coding

Jev is an evaluation model, not a chat model. It takes a `state` (text or JSON) and typed questions, and returns calibrated probabilities instead of prose. It costs a fraction of a cent, answers in a few hundred ms, and evaluates several questions in one round trip. The point of this skill is not to add a tool you call when a user asks for it. It is a habit: when you notice yourself about to *guess* about code, ask Jev instead, then act on the number.

## When to reach for it

Reach for Jev at the moments in a coding task where you would otherwise rely on a gut feeling. The pattern is the same each time: you have concrete evidence (a diff, a file, a log, a test result, a request), and a question with a small answer space.

**Before acting**

- Deciding among candidate locations for a change. Ask a `choice` over the candidate files or functions, with one sentence describing each.
- Judging whether a change is safe to make without asking the user. Ask a `score` on risk from "cosmetic" to "could lose data or break production".
- Deciding whether a task is ambiguous enough to need a question back to the user. Ask a `boolean`: "Could two reasonable engineers implement this request differently in a way that matters?"
- Choosing an approach when two look equivalent. Ask a `choice` between them with the trade-offs as descriptions.

**After acting, before reporting**

- Verifying your diff against the request. State is the request plus the diff; ask "Does this diff fully implement the request?" and "Does this diff change anything the request did not ask for?"
- Checking whether a test failure is caused by your change or was pre-existing. State is the failing test output plus your diff.
- Deciding whether a function you touched needs a new test. Ask a `boolean` with criteria for what "needs a test" means in this repo.
- Grading a commit message or PR description against the diff.

**Triage and classification**

- Sorting issues, log lines, or review comments into buckets. One `choice` question, many items, or one call per item.
- Rating severity, urgency, or confidence on a rubric. `score` with named rungs.
- Routing a task to the right subagent or tool. `choice` over the options.

**Verifying other agents**

- When a subagent returns a result, put the original brief and the result in state and ask whether the result answers the brief, whether it invented anything, and whether it stayed in scope. Do this before relaying the result to the user.

## When not to

- The question needs an explanation, not a decision. Jev cannot say why.
- The answer space is open-ended. Jev picks from what you declare.
- You have not gathered the evidence yet. Jev judges what is in `state`; it cannot read files or run commands. Feed it the diff, not the file path.
- The state is larger than about 32k tokens. Trim to the relevant part.
- The decision is trivially certain either way. Do not add a call to confirm what is obvious.

## How to act on the answer

- Boolean probability above 0.8 or below 0.2: treat as decided and move on. Between: gather more evidence, ask a narrower question, or surface the uncertainty to the user.
- Choice: use `choice` when its probability is clearly ahead. If two options are close, that is itself a finding worth reporting.
- Score: read `score` as a position on the rubric you gave. A 4-rung rubric yields 0 to 3. `confidence` tells you how peaked the distribution is.
- Tell the user when a Jev result changed what you did, in one sentence. Do not narrate every call.

## How to call it

Requires Node 18+ and `JEV_API_KEY` in the environment. If the key only lives in a `.env` file, run `env $(cat .env) node ...` in one command. The key is a Vercel AI Gateway key created in the Vercel dashboard; that is the only place the provider matters. The script is `scripts/jev.mjs` next to this file, for example `~/.claude/skills/jev/scripts/jev.mjs` or the plugin's install path.

Prefer the stdin JSON form. It handles multi-line state, structured state, and criteria without quoting problems.

```bash
node scripts/jev.mjs <<'EOF'
{
  "state": {
    "request": "Add retry to the upload client",
    "diff": "<paste git diff here>"
  },
  "questions": {
    "implements": { "type": "boolean", "instructions": "Does the diff fully implement the request?" },
    "scopeCreep": { "type": "boolean", "instructions": "Does the diff change behaviour the request did not ask for?" },
    "risk": {
      "type": "score",
      "instructions": "How risky is this change to ship?",
      "criteria": ["cosmetic", "low: isolated, covered by tests", "moderate: touches shared code", "high: data, auth, or money paths"]
    }
  }
}
EOF
```

Pipe evidence straight in when the question is simple:

```bash
git diff | node scripts/jev.mjs --score "risk=Risk of shipping this" --scale "cosmetic,low,moderate,high"
npm test 2>&1 | tail -50 | node scripts/jev.mjs --bool "Is the failure caused by a missing dependency rather than a logic error?"
```

Flag reference:

- State, exactly one: `--state <text>`, `--state-file <path>` (a `.json` path is parsed as structured state), `--state-json <json>`. With none, stdin is the state text when question flags are present, otherwise a full request `{state, questions}`.
- Questions, repeatable, keys default to `q1`, `q2` unless written `key=instructions`: `--bool "<q>"`, `--choice "<q>" --options "a=desc,b=desc"`, `--score "<q>" --scale "low,mid,high"`, `--questions <json>` to merge a raw object.
- `--options` and `--scale` are comma-separated; use the JSON form if a description contains a comma.
- `--verbose` prints `{ answers, usage, requestId }`. `--no-retain` asks the service not to retain the input.
- Output is JSON on stdout. Errors exit 1 with a message on stderr prefixed by a code: `auth`, `bad_request`, `rate_limited`, `unavailable`, `unknown`. `--help` prints everything.

Answer shapes:

| Type | Give | Get |
|---|---|---|
| `boolean` | `instructions`, optional `criteria: {true, false}` | `probability` 0..1 |
| `choice` | `instructions`, `criteria: {name: description}` | `choice`, `probabilities`, `confidence` |
| `score` | `instructions`, `criteria: [lowest, ..., highest]` | `score` 0..n-1, `probabilities` keyed `"0".."n-1"`, `confidence` |

As a module from Node code:

```js
import { evaluate, ask, choose, score, JevError } from './scripts/jev.mjs';
await ask(state, instructions, criteria?);           // number
await choose(state, instructions, { name: desc });  // { choice, probabilities, confidence }
await score(state, instructions, [low, ..., high]);  // { score, probabilities, confidence }
await evaluate({ state, questions, retain? });       // { answers, usage, requestId }
```

## Writing questions that work

- Put the evidence in `state` and only the question in `instructions`. Never paste the diff into the instructions.
- Name the keys after the decision: `implements`, `risk`, `needsTest`, not `q1`.
- For `boolean`, add `criteria` whenever "true" is not self-evident. "Needs a test" means different things in different repos; say what it means here.
- For `choice`, describe every option, and add `other` when the input may fit none.
- For `score`, label every rung with a concrete description, lowest first.
- Batch the questions you have about the same evidence into one call.
- Structured state beats a blob. `{ request, diff, testOutput }` lets the model find each part.
