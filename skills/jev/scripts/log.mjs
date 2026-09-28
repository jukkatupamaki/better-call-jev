#!/usr/bin/env node
// Read the local Jev call log as compact text. Zero dependencies, Node 18+.
//
// The log is JSONL written by jev.mjs. It is cheap to write and expensive to read:
// raw JSON costs an agent far more tokens than it is worth. This script streams
// the files, filters, aggregates, and prints short, bounded text. Pass --json for
// machine-readable output.

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { logDir, thresholds, verdict } from './jev.mjs';

const USAGE = `Usage:
  log.mjs summary  [filters]   One screen of numbers: status, latency, undecided rates, bursts, repeats
  log.mjs list     [filters]   One line per call, newest last (default --limit 20)
  log.mjs show     <id>        One call in full; an id prefix is enough. --max <n> caps long values (default 400)
  log.mjs sessions [filters]   One line per session

Filters:
  --since <n>(m|h|d)           Only calls in the last n minutes, hours or days
  --session <id|current>       One session; "current" reads JEV_SESSION_ID
  --status <s>                 ok, refused, sensitive, rate_limited, timeout, auth, bad_request, unavailable, unknown
  --caller <cli|module>
  --undecided                  Only calls with at least one undecided boolean
  --limit <n>                  Max lines for list and sessions (default 20; 0 = no limit)
  --json                       JSON instead of text

Env: JEV_LOG_DIR (log location, see jev.mjs), JEV_THRESHOLD_HIGH / JEV_THRESHOLD_LOW`;

// Reading ------------------------------------------------------------------------

async function* readRecords(dir, sinceMs) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^calls-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return;
  }
  // Monthly files: skip whole months that end before the window starts.
  const sinceMonth = sinceMs ? new Date(sinceMs).toISOString().slice(0, 7) : null;
  for (const f of files) {
    if (sinceMonth && f.slice(6, 13) < sinceMonth) continue;
    const rl = createInterface({ input: createReadStream(join(dir, f), 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; } // a torn line never stops the reader
      yield r;
    }
  }
}

export function parseSince(s, now = Date.now()) {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(s ?? '');
  if (!m) throw new Error(`--since must look like 30m, 2h or 7d, got "${s}"`);
  return now - Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

function booleans(r, t) {
  return Object.entries(r.answers ?? {})
    .filter(([, a]) => a?.type === 'boolean')
    .map(([k, a]) => ({ key: k, probability: a.probability, verdict: verdict(a.probability, t), hasCriteria: !!r.questions?.[k]?.criteria }));
}

function matches(r, f, t) {
  if (f.sinceMs && Date.parse(r.ts) < f.sinceMs) return false;
  if (f.session && r.session !== f.session) return false;
  if (f.status && r.status !== f.status) return false;
  if (f.caller && r.caller !== f.caller) return false;
  if (f.undecided && !booleans(r, t).some((b) => b.verdict === 'undecided')) return false;
  return true;
}

export async function load(dir, f, t) {
  const out = [];
  for await (const r of readRecords(dir, f.sinceMs)) if (matches(r, f, t)) out.push(r);
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

// Formatting helpers ---------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
function clock(ts, withDate) {
  const d = new Date(ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}
const short = (s, n = 8) => (s ? String(s).slice(0, n) : '-');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const ms = (x) => (x == null ? '-' : x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}ms`);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const questionsHash = (q) => createHash('sha256').update(JSON.stringify(q ?? {})).digest('hex').slice(0, 8);
const counts = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
const fmtCounts = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
function spansDays(rs) {
  return rs.length > 1 && new Date(rs[0].ts).toDateString() !== new Date(rs[rs.length - 1].ts).toDateString();
}

function answerText(r, t) {
  if (!r.answers) return Object.entries(r.questions ?? {}).map(([k, q]) => `${k}(${q.type})`).join(' ');
  return Object.entries(r.answers).map(([k, a]) => {
    if (a.type === 'boolean') return `${k}=${a.probability?.toFixed(2)} ${verdict(a.probability, t)}`;
    if (a.type === 'choice') return `${k}=${a.choice}(${(a.probabilities?.[a.choice] ?? a.confidence ?? 0).toFixed(2)})`;
    if (a.type === 'score') return `${k}=${typeof a.score === 'number' ? +a.score.toFixed(1) : a.score}/${Object.keys(a.probabilities ?? {}).length - 1}`;
    return `${k}=?`;
  }).join(' · ');
}

const findingsText = (r) => (r.findings ?? []).map((f) => `${f.kind} in ${f.path}`).join(' · ');

// Bursts: runs of calls in one session with gaps under 1 s, at least 10 long.
export function bursts(rs, { gapMs = 1000, min = 10 } = {}) {
  const bySession = new Map();
  for (const r of rs) {
    const k = r.session ?? '-';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(r);
  }
  const out = [];
  for (const [session, list] of bySession) {
    let run = [list[0]];
    const flush = () => {
      if (run.length >= min) out.push({ session, calls: run.length, start: run[0].ts, spanMs: Date.parse(run[run.length - 1].ts) - Date.parse(run[0].ts), refused: run.filter((r) => r.status === 'refused').length });
    };
    for (let i = 1; i < list.length; i++) {
      if (Date.parse(list[i].ts) - Date.parse(list[i - 1].ts) < gapMs) run.push(list[i]);
      else { flush(); run = [list[i]]; }
    }
    flush();
  }
  return out;
}

// Commands -----------------------------------------------------------------------

export function summarize(rs, t) {
  const sent = rs.filter((r) => r.status !== 'refused' && r.status !== 'sensitive');
  const ok = rs.filter((r) => r.status === 'ok');
  const bools = ok.flatMap((r) => booleans(r, t));
  const withC = bools.filter((b) => b.hasCriteria);
  const without = bools.filter((b) => !b.hasCriteria);
  const und = (xs) => xs.filter((b) => b.verdict === 'undecided').length;
  const choices = ok.flatMap((r) => Object.values(r.answers ?? {}).filter((a) => a?.type === 'choice'));
  const close = choices.filter((a) => {
    const p = Object.values(a.probabilities ?? {}).sort((x, y) => y - x);
    return p.length > 1 && p[0] - p[1] < 0.15;
  });
  const scores = ok.flatMap((r) => Object.values(r.answers ?? {}).filter((a) => a?.type === 'score'));
  const lat = ok.map((r) => r.latencyMs).filter((x) => typeof x === 'number');
  const qsPerCall = sent.map((r) => Object.keys(r.questions ?? {}).length);
  const repeats = Object.entries(counts(sent.map((r) => questionsHash(r.questions))))
    .filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([hash, n]) => {
      const r = sent.find((x) => questionsHash(x.questions) === hash);
      return { hash, calls: n, keys: Object.keys(r.questions ?? {}) };
    });
  return {
    calls: rs.length,
    sessions: new Set(rs.map((r) => r.session ?? '-')).size,
    from: rs[0]?.ts ?? null,
    to: rs[rs.length - 1]?.ts ?? null,
    status: counts(rs.map((r) => r.status)),
    caller: counts(rs.map((r) => r.caller)),
    latency: { p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) },
    tokens: { input: ok.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0), output: ok.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0) },
    questionsPerCall: qsPerCall.length ? qsPerCall.reduce((a, b) => a + b, 0) / qsPerCall.length : null,
    booleans: { total: bools.length, undecided: und(bools), withCriteria: withC.length, undecidedWithCriteria: und(withC), withoutCriteria: without.length, undecidedWithoutCriteria: und(without) },
    choices: { total: choices.length, closeRace: close.length },
    scores: { total: scores.length },
    bursts: bursts(rs),
    repeats,
    thresholds: t,
  };
}

function printSummary(s) {
  if (!s.calls) return console.log('no calls match');
  const b = s.booleans;
  const lines = [
    `${s.calls} call${s.calls === 1 ? '' : 's'} · ${s.sessions} session${s.sessions === 1 ? '' : 's'} · ${clock(s.from, true)} → ${clock(s.to, true)}`,
    `status    ${fmtCounts(s.status)}`,
    `caller    ${fmtCounts(s.caller)}`,
    `latency   p50 ${ms(s.latency.p50)} · p95 ${ms(s.latency.p95)} (ok calls)`,
    `tokens    in ${s.tokens.input} · out ${s.tokens.output}`,
    `per call  ${s.questionsPerCall == null ? '-' : s.questionsPerCall.toFixed(1)} questions`,
  ];
  if (b.total) lines.push(`booleans  ${b.total} · undecided ${pct(b.undecided, b.total)} (with criteria ${pct(b.undecidedWithCriteria, b.withCriteria)} of ${b.withCriteria}, without ${pct(b.undecidedWithoutCriteria, b.withoutCriteria)} of ${b.withoutCriteria}) at ${s.thresholds.high}/${s.thresholds.low}`);
  if (s.choices.total) lines.push(`choices   ${s.choices.total} · close race (top two within 0.15) ${s.choices.closeRace}`);
  if (s.scores.total) lines.push(`scores    ${s.scores.total}`);
  for (const x of s.bursts) lines.push(`burst     ${x.calls} calls in ${ms(x.spanMs)} at ${clock(x.start, true)}, session ${short(x.session)}${x.refused ? `, ${x.refused} refused` : ''}`);
  for (const x of s.repeats) lines.push(`repeat    same questions ${x.calls}× [${clip(x.keys.join(','), 60)}] (${x.hash})`);
  console.log(lines.join('\n'));
}

function printList(rs, t) {
  if (!rs.length) return console.log('no calls match');
  const withDate = spansDays(rs);
  for (const r of rs) {
    const line = [clock(r.ts, withDate), short(r.id), short(r.session), r.caller ?? '-', r.status, ms(r.latencyMs).padStart(6), r.status === 'refused' ? '' : r.status === 'sensitive' ? findingsText(r) : answerText(r, t)].join('  ');
    console.log(clip(line.trimEnd(), 200));
  }
}

function printShow(r, t, max) {
  const val = (v) => clip(typeof v === 'string' ? v : JSON.stringify(v), max);
  const lines = [
    `id        ${r.id}`,
    `time      ${clock(r.ts, true)} · ${ms(r.latencyMs)}`,
    `session   ${r.session ?? '-'} · caller ${r.caller ?? '-'} · ${r.status}${r.http ? ` (HTTP ${r.http})` : ''}`,
  ];
  if (r.requestId) lines.push(`request   ${r.requestId}`);
  if (r.usage) lines.push(`tokens    in ${r.usage.inputTokens ?? '-'} · out ${r.usage.outputTokens ?? '-'}`);
  if (r.error) lines.push(`error     ${val(r.error)}`);
  if (r.findings) lines.push(`blocked   ${findingsText(r)} (request not stored)`);
  if (r.stateBytes != null) lines.push(`state     ${r.stateType} · ${r.stateBytes} bytes${r.stateKeys ? ` · keys ${r.stateKeys.join(', ')}` : ''}${'state' in r ? '' : ' · not stored'}`);
  if ('state' in r) lines.push(`          ${val(r.state)}`);
  let prevCriteria;
  for (const [k, q] of Object.entries(r.questions ?? {})) {
    lines.push(`q ${k} (${q.type}): ${val(q.instructions ?? '')}`);
    if (q.criteria) {
      const c = JSON.stringify(q.criteria);
      lines.push(`    criteria ${c === prevCriteria ? 'same as above' : val(q.criteria)}`);
      prevCriteria = c;
    }
    const a = r.answers?.[k];
    if (a) lines.push(`    → ${answerText({ answers: { [k]: a } }, t).slice(k.length + 1)}${a.type !== 'boolean' ? ` · ${val(a.probabilities)}` : ''}`);
  }
  console.log(lines.join('\n'));
}

function sessionRows(rs, t) {
  const m = new Map();
  for (const r of rs) {
    const k = r.session ?? '-';
    if (!m.has(k)) m.set(k, { session: k, first: r.ts, last: r.ts, calls: 0, ok: 0, errors: 0, refused: 0, booleans: 0, undecided: 0 });
    const s = m.get(k);
    s.last = r.ts;
    s.calls++;
    if (r.status === 'ok') s.ok++;
    else if (r.status === 'refused') s.refused++;
    else s.errors++;
    for (const b of booleans(r, t)) { s.booleans++; if (b.verdict === 'undecided') s.undecided++; }
  }
  return [...m.values()].sort((a, b) => (a.first < b.first ? -1 : 1));
}

function printSessions(rows) {
  if (!rows.length) return console.log('no calls match');
  for (const s of rows) {
    console.log([clock(s.first, true), short(s.session), `${s.calls} call${s.calls === 1 ? '' : 's'}`, `ok ${s.ok}`, `errors ${s.errors}`, s.refused ? `refused ${s.refused}` : null, s.booleans ? `undecided ${pct(s.undecided, s.booleans)}` : null].filter(Boolean).join('  '));
  }
}

// CLI ------------------------------------------------------------------------------

async function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    args.splice(i, 2);
    return v;
  };
  const has = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };
  if (!args.length || has('-h') || has('--help')) return console.log(USAGE);

  const cmd = args.shift();
  const json = has('--json');
  const since = take('--since');
  let session = take('--session');
  if (session === 'current') {
    session = process.env.JEV_SESSION_ID;
    if (!session) throw new Error('--session current needs JEV_SESSION_ID (set by the plugin\'s SessionStart hook)');
  }
  const f = { sinceMs: since ? parseSince(since) : null, session, status: take('--status'), caller: take('--caller'), undecided: has('--undecided') };
  const limitArg = take('--limit');
  const limit = limitArg === undefined ? 20 : Number(limitArg);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('--limit must be a whole number, 0 for no limit');
  const maxArg = take('--max');
  const max = maxArg === undefined ? 400 : Number(maxArg);
  const id = cmd === 'show' ? args.shift() : undefined;
  if (args.length) throw new Error(`Unknown arguments: ${args.join(' ')}\n\n${USAGE}`);

  const t = thresholds();
  const dir = await logDir();
  const tail = (xs) => (limit ? xs.slice(-limit) : xs);

  if (cmd === 'summary') {
    const s = summarize(await load(dir, f, t), t);
    return json ? console.log(JSON.stringify(s)) : printSummary(s);
  }
  if (cmd === 'list') {
    const rs = tail(await load(dir, f, t));
    return json ? console.log(JSON.stringify(rs)) : printList(rs, t);
  }
  if (cmd === 'sessions') {
    const rows = tail(sessionRows(await load(dir, f, t), t));
    return json ? console.log(JSON.stringify(rows)) : printSessions(rows);
  }
  if (cmd === 'show') {
    if (!id) throw new Error('show needs an id (a prefix is enough)');
    const hits = (await load(dir, f, t)).filter((r) => r.id?.startsWith(id));
    if (!hits.length) throw new Error(`No call with id ${id}`);
    if (hits.length > 1) throw new Error(`Id prefix ${id} matches ${hits.length} calls; give more characters`);
    return json ? console.log(JSON.stringify(hits[0])) : printShow(hits[0], t, max);
  }
  throw new Error(`Unknown command "${cmd}"\n\n${USAGE}`);
}

async function isCli() {
  if (!process.argv[1]) return false;
  const { realpathSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await isCli()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
