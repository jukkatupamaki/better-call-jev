---
name: jev-stats
description: Summarise how Jev has been used, from the local call log. Shows call counts, errors, latency, undecided rates, bursts and repeated questions, per session or over a time window, and points out what to change. Use when asked about Jev stats, usage, the call log, why calls failed or were rate limited, or how well Jev questions are working. Triggers on "jev stats", "jev usage", "jev log", "how is jev doing".
---

# Jev stats

Every Jev call is logged locally as JSONL. Never read those files directly: raw JSON costs far more tokens than it tells you. Use the reader, which prints short, bounded text:

```bash
node <plugin root>/skills/jev/scripts/log.mjs summary              # start here
node <plugin root>/skills/jev/scripts/log.mjs summary --since 7d
node <plugin root>/skills/jev/scripts/log.mjs sessions
node <plugin root>/skills/jev/scripts/log.mjs list --undecided     # one line per call
node <plugin root>/skills/jev/scripts/log.mjs show <id prefix>     # one call in full
```

The script is `../jev/scripts/log.mjs` relative to this file (the plugin root is `$CLAUDE_PLUGIN_ROOT`). Filters for every command: `--since 30m|2h|7d`, `--session <id|current>`, `--status <s>`, `--caller cli|module`, `--undecided`, `--limit <n>`. `--help` lists everything.

## How to answer

1. Run `summary`, with `--since` or `--session current` if the user asked about a period or this session.
2. Drill down only as far as the question needs: `sessions` to find where something happened, `list` with filters to see the calls, `show` for one call. Keep `--limit` small.
3. Report the few numbers that matter and what they mean. Do not paste the whole output back.

## Reading the numbers

- **status**: `refused` means the client stopped the call itself during a rate-limit cooldown; nothing was sent. Many `refused` or `rate_limited` next to a **burst** means something fanned out calls instead of batching them.
- **booleans undecided**: the share of boolean answers between the thresholds. Compare "with criteria" and "without": if questions without criteria are undecided much more often, the fix is to add criteria.
- **close race** on choices: the top two options were within 0.15. Often options that overlap or are described too vaguely.
- **per call**: questions per call. Near 1 with many calls on the same evidence means questions are not being batched.
- **repeat**: the same question set sent many times. Usually a loop over items that should have been one batched call.
- **latency**: p50 and p95 of successful calls. A p95 near the timeout (8 s by default) means large state; trim the evidence.

## Where the log is

`$JEV_LOG_DIR`, else `$CLAUDE_PLUGIN_DATA/logs`, else `$XDG_STATE_HOME/better-call-jev`, else `~/.local/state/better-call-jev`. One file per month. `JEV_LOG=meta` stops storing state, `JEV_LOG=off` stops logging.
