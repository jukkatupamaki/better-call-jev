// log.mjs: compact reader for the local call log. Runs the CLI against a fixture dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, runCli, withEnv, withStub } from './helpers.mjs';
import { parseSince, bursts } from '../skills/jev/scripts/log.mjs';
import { evaluate } from '../skills/jev/scripts/jev.mjs';

const LOG = join(ROOT, 'skills', 'jev', 'scripts', 'log.mjs');
const ENV = { TZ: 'UTC' };

const BOOL = (instructions, criteria) => ({ type: 'boolean', instructions, ...(criteria && { criteria }) });
const rec = (o) => ({ v: 1, caller: 'cli', status: 'ok', latencyMs: 400, usage: { inputTokens: 100, outputTokens: 10 }, stateBytes: 10, stateType: 'string', state: 'x', ...o });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-logread-'));
  const aug = [
    rec({ id: 'aaaa1111-0000-4000-8000-000000000001', ts: '2026-08-31T10:00:00.000Z', session: 'old', questions: { ok: BOOL('ok?') }, answers: { ok: { type: 'boolean', probability: 0.9 } } }),
  ];
  const sep = [
    rec({ id: 'bbbb2222-0000-4000-8000-000000000001', ts: '2026-09-22T10:00:00.000Z', session: 's1', latencyMs: 300,
      questions: { safe: BOOL('safe?', { true: 'y', false: 'n' }), scope: BOOL('in scope?') },
      answers: { safe: { type: 'boolean', probability: 0.95 }, scope: { type: 'boolean', probability: 0.5 } } }),
    rec({ id: 'bbbb2222-0000-4000-8000-000000000002', ts: '2026-09-22T10:00:05.000Z', session: 's1', latencyMs: 900,
      questions: { pick: { type: 'choice', instructions: 'which', criteria: { a: 'A', b: 'B' } } },
      answers: { pick: { type: 'choice', choice: 'a', probabilities: { a: 0.52, b: 0.48 }, confidence: 0.1 } } }),
    rec({ id: 'cccc3333-0000-4000-8000-000000000001', ts: '2026-09-22T11:00:00.000Z', session: 's2', status: 'rate_limited', http: 429, answers: null, usage: null, latencyMs: 50,
      questions: { ok: BOOL('ok?') }, error: 'Jev request failed (rate_limited): too many' }),
  ];
  // A burst of 12 refused calls in session s2, 10 ms apart.
  for (let i = 0; i < 12; i++) {
    sep.push({ v: 1, id: `dddd4444-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, ts: new Date(Date.parse('2026-09-22T11:00:00.100Z') + i * 10).toISOString(), session: 's2', caller: 'module', status: 'refused' });
  }
  writeFileSync(join(dir, 'calls-2026-08.jsonl'), aug.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'calls-2026-09.jsonl'), sep.map((r) => JSON.stringify(r)).join('\n') + '\n{"torn line\n');
  return dir;
}

const run = (args, dir, env = {}) => runCli(args, { script: LOG, env: { ...ENV, JEV_LOG_DIR: dir, ...env } });

test('summary gives counts, latency, undecided split by criteria, bursts and repeats', async () => {
  const r = await run(['summary'], fixture());
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /^16 calls · 3 sessions · 2026-08-31 10:00:00 → 2026-09-22 11:00:00/);
  assert.match(out, /status\s+refused 12 · ok 3 · rate_limited 1/);
  assert.match(out, /caller\s+module 12 · cli 4/);
  assert.match(out, /latency\s+p50 400ms · p95 900ms/);
  assert.match(out, /booleans\s+3 · undecided 33% \(with criteria 0% of 1, without 50% of 2\)/);
  assert.match(out, /choices\s+1 · close race \(top two within 0\.15\) 1/);
  assert.match(out, /burst\s+13 calls in 210ms .*session s2, 12 refused/);
  assert.ok(out.split('\n').length <= 15, 'summary stays short');
});

test('summary --json is machine readable', async () => {
  const r = await run(['summary', '--json'], fixture());
  assert.equal(r.json.calls, 16);
  assert.equal(r.json.booleans.undecided, 1);
  assert.deepEqual(r.json.thresholds, { high: 0.8, low: 0.2 });
});

test('thresholds from env change what counts as undecided', async () => {
  const r = await run(['summary', '--json'], fixture(), { JEV_THRESHOLD_HIGH: '0.99', JEV_THRESHOLD_LOW: '0.01' });
  assert.equal(r.json.booleans.undecided, 3);
});

test('list prints one compact line per call, newest last, with answers', async () => {
  const r = await run(['list', '--status', 'ok'], fixture());
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^2026-08-31 10:00:00  aaaa1111  old  cli  ok  +400ms  ok=0\.90 yes$/);
  assert.match(lines[1], /safe=0\.95 yes · scope=0\.50 undecided/);
  assert.match(lines[2], /pick=a\(0\.52\)/);
});

test('list --limit keeps the newest, and refused lines stay minimal', async () => {
  const r = await run(['list', '--limit', '2'], fixture());
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) assert.match(l, /module  refused  +-$/);
});

test('filters: session, caller, since, undecided', async () => {
  const dir = fixture();
  assert.equal((await run(['list', '--session', 's1'], dir)).stdout.trim().split('\n').length, 2);
  assert.equal((await run(['list', '--caller', 'module', '--limit', '0'], dir)).stdout.trim().split('\n').length, 12);
  const und = (await run(['list', '--undecided'], dir)).stdout.trim().split('\n');
  assert.equal(und.length, 1);
  assert.match(und[0], /scope=0\.50 undecided/);
  // Nothing in the fixture is recent.
  assert.equal((await run(['list', '--since', '1h'], dir)).stdout.trim(), 'no calls match');
});

test('--session current reads CLAUDE_CODE_SESSION_ID, and JEV_SESSION_ID overrides it', async () => {
  const dir = fixture();
  const r = await run(['list', '--session', 'current'], dir, { CLAUDE_CODE_SESSION_ID: 'old' });
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const o = await run(['list', '--session', 'current'], dir, { CLAUDE_CODE_SESSION_ID: 'old', JEV_SESSION_ID: 's1' });
  assert.equal(o.stdout.trim().split('\n').length, 2);
  const missing = await run(['list', '--session', 'current'], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /CLAUDE_CODE_SESSION_ID/);
});

const lineCount = (dir, f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').length;

test('clean --session removes only that session and keeps torn lines', async () => {
  const dir = fixture();
  const r = await run(['clean', '--session', 's2'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'removed 13 calls · 3 kept');
  assert.equal(lineCount(dir, 'calls-2026-09.jsonl'), 3); // two s1 calls and the torn line
  assert.equal((await run(['sessions'], dir)).stdout.trim().split('\n').length, 2);
});

test('clean --older-than drops whole months and --dry-run touches nothing', async () => {
  const dir = fixture();
  const before = Date.now() - Date.parse('2026-09-01T00:00:00Z');
  const age = `${Math.floor(before / 3600e3)}h`;
  const dry = await run(['clean', '--older-than', age, '--dry-run'], dir);
  assert.equal(dry.stdout.trim(), 'would remove 1 call · 15 kept');
  assert.deepEqual(readdirSync(dir).sort(), ['calls-2026-08.jsonl', 'calls-2026-09.jsonl']);
  await run(['clean', '--older-than', age], dir);
  assert.deepEqual(readdirSync(dir), ['calls-2026-09.jsonl']);
});

test('clean --all empties the log; clean without a selector is an error', async () => {
  const dir = fixture();
  const bare = await run(['clean'], dir);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /--all/);
  const r = await run(['clean', '--all', '--json'], dir);
  assert.deepEqual(r.json, { removed: 16, kept: 0, dryRun: false });
  assert.deepEqual(readdirSync(dir), ['calls-2026-09.jsonl']); // only the torn line is left
});

test('show finds a call by id prefix and prints it compactly', async () => {
  const r = await run(['show', 'bbbb2222-0000-4000-8000-000000000001'], fixture());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^id\s+bbbb2222-/);
  assert.match(r.stdout, /q safe \(boolean\): safe\?\n\s+criteria \{"true":"y","false":"n"\}\n\s+→ 0\.95 yes/);
  assert.match(r.stdout, /q scope \(boolean\): in scope\?\n\s+→ 0\.50 undecided/);
});

test('show: ambiguous and unknown prefixes are errors', async () => {
  const dir = fixture();
  const amb = await run(['show', 'bbbb'], dir);
  assert.equal(amb.code, 1);
  assert.match(amb.stderr, /matches 2 calls/);
  const none = await run(['show', 'ffff'], dir);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No call/);
});

test('show collapses repeated criteria and clips long values with --max', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-logread-'));
  const scale = ['low', 'mid', 'high'];
  writeFileSync(join(dir, 'calls-2026-09.jsonl'), JSON.stringify(rec({
    id: 'eeee', ts: '2026-09-22T10:00:00.000Z', state: 'y'.repeat(1000),
    questions: { a: { type: 'score', instructions: 'a', criteria: scale }, b: { type: 'score', instructions: 'b', criteria: scale } },
    answers: { a: { type: 'score', score: 1.234, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } }, b: { type: 'score', score: 2, probabilities: { 0: 0, 1: 0, 2: 1 } } },
  })) + '\n');
  const r = await run(['show', 'eeee', '--max', '50'], dir);
  assert.match(r.stdout, /criteria \["low","mid","high"\]/);
  assert.match(r.stdout, /criteria same as above/);
  assert.match(r.stdout, /→ 1\/2\(0\.60 e1\.2\)/);
  assert.match(r.stdout, /y{49}…/);
  assert.ok(!r.stdout.includes('y'.repeat(60)));
});

test('sessions prints one line per session', async () => {
  const r = await run(['sessions'], fixture());
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /s1  2 calls  ok 2  errors 0  undecided 50%/);
  assert.match(lines[2], /s2  13 calls  ok 0  errors 1  refused 12/);
});

test('empty or missing log dir says so', async () => {
  const r = await run(['summary'], join(tmpdir(), 'jev-does-not-exist-' + Date.now()));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'no calls match');
});

test('bad arguments exit 1 with a message', async () => {
  const dir = fixture();
  for (const args of [['nope'], ['list', '--since', '3 days'], ['list', '--limit', '-1'], ['list', '--bogus'], ['show']]) {
    const r = await run(args, dir);
    assert.equal(r.code, 1, args.join(' '));
    assert.ok(r.stderr.length > 0);
  }
});

test('no arguments prints usage', async () => {
  const r = await run([], fixture());
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Usage:/);
});

test('parseSince', () => {
  const now = 1_000_000_000;
  assert.equal(parseSince('30m', now), now - 30 * 60e3);
  assert.equal(parseSince('2h', now), now - 2 * 3600e3);
  assert.equal(parseSince('1.5d', now), now - 1.5 * 86400e3);
  assert.throws(() => parseSince('7'));
});

test('bursts need 10 calls under 1 s apart in one session', () => {
  const at = (s, i, gap) => ({ session: s, ts: new Date(i * gap).toISOString(), status: 'ok' });
  assert.equal(bursts(Array.from({ length: 9 }, (_, i) => at('a', i, 10))).length, 0);
  assert.equal(bursts(Array.from({ length: 10 }, (_, i) => at('a', i, 10))).length, 1);
  assert.equal(bursts(Array.from({ length: 10 }, (_, i) => at('a', i, 2000))).length, 0);
});

test('refused calls are logged as minimal records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-refused-'));
  const Q = { ok: BOOL('ok?') };
  await withEnv({ JEV_API_KEY: 'k', JEV_LOG_DIR: dir, JEV_COOLDOWN_MS: '60000', JEV_SESSION_ID: 'sx' }, () =>
    withStub(async () => new Response('{"error":{"message":"slow"}}', { status: 429 }), async () => {
      await Promise.allSettled(Array.from({ length: 20 }, () => evaluate({ state: 'x', questions: Q })));
    }));
  const rs = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const refused = rs.filter((r) => r.status === 'refused');
  assert.equal(rs.length, 20);
  assert.ok(refused.length >= 16);
  for (const r of refused) assert.deepEqual(Object.keys(r).sort(), ['caller', 'id', 'session', 'status', 'ts', 'v']);
  const r = await run(['summary'], dir);
  assert.match(r.stdout, /refused \d+ · rate_limited \d+/);
});
