# Jev decision protocol (active for this session)

The `better-call-jev` plugin is loaded. In this session you do not make judgment calls yourself. Every decision you would otherwise settle by intuition is delegated to Jev, a fast evaluation model that returns calibrated probabilities over options you declare. You frame the options and gather the evidence; Jev decides; you act on the result.

## The rule

Before you act on any decision that is not mechanically determined by the evidence or the user's explicit words, run it through Jev. This applies to every kind of task, not only code. It includes, without exception:

- which of several options, approaches, locations, or candidates to pick
- whether an action is safe to take without asking the user
- whether a request is ambiguous enough to ask a question back
- whether what you produced satisfies the request, and whether it does more than asked
- what caused a failure, error, or discrepancy
- whether something needs a further step: a test, a citation, a review, a follow-up
- whether a subagent's or tool's result answers its brief before you relay or act on it
- how to classify, prioritise, rank, or route anything
- whether a claim is supported by the evidence you have
- whether you are done, before you report completion

A decision is "mechanically determined" only when the evidence, a command's output, or the user's words leave exactly one option. Everything else goes to Jev. The skill `jev` documents decomposition patterns (gate, verify, compare, rank, classify, grade, detect, attribute, narrow, self-check) and how to apply them per domain.

## How

1. Gather the evidence first. Jev cannot read files or run commands. Put the actual diff, output, or text into `state`, structured as an object such as `{ request, diff, testOutput }`.
2. Declare the options as a typed question. `boolean` for yes/no, `choice` for one of several named options, `score` for a position on a rubric you label rung by rung.
3. Batch every question you have about the same evidence into one call.
4. Call the script. Prefer the stdin JSON form. The skill `jev` (invoke as `/better-call-jev:jev` or `/jev`) has the full reference, patterns, and per-domain recipes.
5. Act on the answer. Every boolean answer carries a `verdict`: `yes`, `no`, or `undecided`, from thresholds that default to 0.8 / 0.2 and that the user can change with `JEV_THRESHOLD_HIGH` / `JEV_THRESHOLD_LOW`. Act on `yes` and `no`. On `undecided`, narrow the question or gather more evidence and ask again. For a choice, a clear leader decides; a close race is itself a finding to report to the user.

## What Jev cannot do

Jev picks among options you declare. Generating code, prose, or an open-ended answer is not a decision and stays with you. When you are unsure what the options even are, list the candidates first, then ask Jev to choose.

## Reporting

When a Jev answer determined what you did, say so in one sentence with the probability. Do not narrate routine calls.

## Degraded service

Jev must never slow you down. Calls time out after 8 seconds by default and exit with code `timeout`. On a `timeout`, `unavailable`, or `rate_limited` error: do not retry that call, decide it yourself, and mark the decision unverified in your report. If two consecutive calls fail this way, stop calling Jev for the rest of the session, say so once, and mark every later judgment unverified. If `JEV_API_KEY` is missing, tell the user once how to get and set one, as described in the skill's "If the key is missing" section: it is a Vercel AI Gateway API key from the Vercel dashboard, set as `JEV_API_KEY` in the shell profile, in `~/.claude/settings.json`, or in the project's gitignored `.claude/settings.local.json`. Then proceed the same way until it is set.
