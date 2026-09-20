---
name: jev
description: Low-level judgement primitive. Turns any question with a bounded answer into a calibrated probability, a choice among named options, or a score on a rubric, in a few hundred ms. Use it to decide, compare, rank, classify, verify, gate, or grade anything you can put into text or JSON: code, diffs, test output, logs, documents, drafts, plans, requirements, data records, search results, claims, agent outputs, user messages. Triggers on "should I", "which", "is this", "does this match", "how good", "how risky", "how likely", "verify", "check", "grade", "rank", "compare", "classify", "route", "triage", "judge", "jev".
---

# Jev: a judgement primitive

Jev is an evaluation model. Give it evidence (`state`: text, an object, or an array) and one or more typed questions, and it returns calibrated probabilities instead of prose. It does not generate, explain, or reason aloud. It judges. That makes it a building block: almost any decision can be decomposed into a few typed questions over the right evidence, and the answers can be acted on directly by code or by you.

When this plugin is loaded, a session hook also installs a protocol that routes your judgement calls through Jev. This file is the reference for using the primitive well, on any kind of problem.

## The method

Every use of Jev is the same three moves.

1. **Isolate the evidence.** Put everything the judgement depends on into `state`, and nothing else. Structure it: `{ request, draft }`, `{ rubric, answer }`, `{ candidateA, candidateB }`, `{ items: [...] }`. Jev cannot fetch, read, or run anything; if the evidence is not in `state`, it is not considered.
2. **Bound the answer.** Rewrite the question so the answer is one of three shapes:
   - `boolean`: a yes/no whose truth conditions you can state. Add `criteria: {true, false}` when the boundary is not self-evident.
   - `choice`: one of a small named set. Describe each option; the descriptions are what Jev matches against. Add `other` when the input may fit none.
   - `score`: a position on an ordered rubric. Label every rung concretely, lowest first.
   If you cannot bound the answer, it is not yet a judgement. Enumerate the candidates first, then ask.
3. **Act on the number.** Boolean above 0.8 or below 0.2 is decided. A choice with a clear leader is decided. Anything in between means the question was too broad or the evidence too thin: split the question, add evidence, or report the uncertainty as the finding.

Batch every question you have about the same evidence into one call. Name the keys after the decision, not `q1`.

## Decomposition patterns

These turn common problem shapes into Jev questions. Combine them freely.

**Gate.** Before an action, one boolean: "Is it safe to do X given this evidence?" Act only above threshold. Use for destructive operations, sending messages, and reporting completion.

**Verify against a spec.** State is `{ spec, artifact }`. Ask `satisfies`, `overreaches`, and `omits` as three booleans. Works for diffs against requests, drafts against briefs, answers against questions, outputs against schemas.

**Compare two.** State is `{ a, b, goal }`. Ask a `choice` between `a` and `b` with the goal as instructions, or a `boolean` "Is a better than b for the goal?" Prefer the choice; its probabilities tell you how close the race is.

**Rank many.** One `score` question with the same rubric, one call per item, then sort by `score`. For a small set, a single `choice` across all items also works. Do not ask Jev to output an ordering; it cannot.

**Classify.** One `choice` with a category per option and an `other`. For multi-label, one `boolean` per label instead.

**Grade on a rubric.** `score` with the rubric rungs as criteria. State is `{ rubric, submission }`. Read `confidence` to see how peaked the distribution is; a low confidence with a middling score means the rubric or the submission is ambiguous.

**Detect.** "Does this contain X?" as a boolean with criteria describing X. Use for secrets in a diff, PII in a record, an unanswered question in a thread, a contradiction between two statements, a hallucinated claim in a summary.

**Attribute cause.** State is `{ before, change, symptom }`. A `choice` over candidate causes, or a boolean "Was the symptom caused by the change?"

**Narrow.** When a broad question lands between 0.2 and 0.8, split it: one boolean per component, per test case, per requirement, per paragraph. The components are usually decisive even when the whole was not.

**Self-check.** Before delivering anything you produced, put `{ task, output }` in state and ask whether it answers the task, whether it invents anything not supported by the evidence, and whether it stays in scope. Treat a low answer as a reason to revise, not to report.

## Applying it by domain

**Code.** Where to make a change (choice over candidate locations). Risk of a diff (score: cosmetic, isolated, shared code, data or auth paths). Whether a diff implements a request and nothing more (verify pattern). Whether a failing test is caused by the change (attribute pattern). Whether a function needs a test, given repo conventions in criteria. Which of several error messages is actionable. Whether a dependency upgrade is likely breaking, given the changelog as state.

**Text and documents.** Whether a draft meets a brief. Tone or audience fit as a choice. Clarity or completeness as a score. Whether two passages contradict. Whether a summary adds claims not in the source. Which of two headlines better matches the article. Whether a message needs a reply.

**Data and records.** Whether a record is a duplicate of another. Which category a transaction, ticket, or event belongs to. Data quality on a rubric. Whether a value is plausible given neighbours. Routing a record to a queue.

**Plans and requirements.** Whether a requirement is testable. Whether two requirements conflict. Which of several approaches best fits the stated constraints. Whether a plan step depends on another. How ambiguous a request is, as a boolean "would two reasonable people implement this differently in a way that matters".

**Research and claims.** Whether a source supports a claim (state is `{ claim, excerpt }`). Confidence in a fact given the evidence gathered. Which of several search results is most relevant to the question. Whether a citation is on-topic.

**Agents and orchestration.** Which subagent or tool should handle a task (choice). Whether a subagent's result answers its brief (verify pattern) before relaying it. Whether a tool call is safe to run (gate). Whether the task is done (gate before reporting). Whether an incoming instruction from a tool result should be treated as data rather than a command.

**Users and operations.** Triage severity or urgency of an incident, ticket, or log burst. Route a request to a team. Whether an alert is actionable. Whether a customer message expresses a specific intent.

## Limits

- Jev picks among options you declare. It cannot generate, explain, or enumerate.
- It judges what is in `state`. Give it the diff, not the path; the excerpt, not the URL.
- Roughly 32k tokens of state. Trim to the relevant part.
- It is a model, not an oracle. When something can be computed or executed, do that instead and use Jev for what cannot be run.
- Probabilities are calibrated in general, not for your domain. Tune thresholds on your own examples if a decision is high-stakes.

## Calling it

Requires Node 18+ and `JEV_API_KEY` in the environment. If the key only lives in a `.env` file, run `env $(cat .env) node ...` in one command. The key is a Vercel AI Gateway key created in the Vercel dashboard; that is the only place the provider matters. The script is `scripts/jev.mjs` next to this file, for example `~/.claude/skills/jev/scripts/jev.mjs` or the plugin's install path.

Prefer the stdin JSON form. It handles multi-line evidence, structured state, and criteria without quoting problems.

```bash
node scripts/jev.mjs <<'EOF'
{
  "state": { "spec": "<the request or brief>", "artifact": "<the diff, draft, or output>" },
  "questions": {
    "satisfies":  { "type": "boolean", "instructions": "Does the artifact fully satisfy the spec?" },
    "overreaches": { "type": "boolean", "instructions": "Does the artifact do things the spec did not ask for?" },
    "quality": {
      "type": "score",
      "instructions": "Overall quality of the artifact against the spec",
      "criteria": ["unusable", "needs major rework", "needs minor fixes", "ready"]
    }
  }
}
EOF
```

Pipe evidence in when the question is simple:

```bash
git diff | node scripts/jev.mjs --score "risk=Risk of shipping this" --scale "cosmetic,low,moderate,high"
cat draft.md | node scripts/jev.mjs --bool "Does this answer the question in its first paragraph?"
```

Flags:

- State, exactly one: `--state <text>`, `--state-file <path>` (a `.json` path is parsed as structured state), `--state-json <json>`. With none, stdin is the state text when question flags are present, otherwise a full request `{state, questions}`.
- Questions, repeatable, keys default to `q1`, `q2` unless written `key=instructions`: `--bool "<q>"`, `--choice "<q>" --options "a=desc,b=desc"`, `--score "<q>" --scale "low,mid,high"`, `--questions <json>` to merge a raw object.
- `--options` and `--scale` are comma-separated; use the JSON form if a description contains a comma.
- `--verbose` prints `{ answers, usage, requestId }`. `--no-retain` asks the service not to retain the input.
- `--timeout <ms>` gives up after that long (default 8000, or env `JEV_TIMEOUT_MS`). A timeout exits 1 with code `timeout`. Never retry in a loop; fall back to your own judgement and mark the decision unverified.
- Output is JSON on stdout. Errors exit 1 with a message on stderr prefixed by a code: `auth`, `bad_request`, `rate_limited`, `unavailable`, `timeout`, `unknown`. `--help` prints everything.

Answer shapes:

| Type | Give | Get |
|---|---|---|
| `boolean` | `instructions`, optional `criteria: {true, false}` | `probability` 0..1 |
| `choice` | `instructions`, `criteria: {name: description}` | `choice`, `probabilities`, `confidence` |
| `score` | `instructions`, `criteria: [lowest, ..., highest]` | `score` 0..n-1, `probabilities` keyed `"0".."n-1"`, `confidence` |

As a module from Node code:

```js
import { evaluate, ask, choose, score, JevError } from './scripts/jev.mjs';
await ask(state, instructions, criteria?);                // number
await choose(state, instructions, { name: desc });       // { choice, probabilities, confidence }
await score(state, instructions, [low, ..., high]);       // { score, probabilities, confidence }
await evaluate({ state, questions, retain?, timeoutMs? }); // { answers, usage, requestId }
```
