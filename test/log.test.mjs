// Local call log: one JSONL record per evaluate() call, never affecting the call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, logDir, logFileName, logLevel } from '../skills/jev/scripts/jev.mjs';
import { withFetch, withEnv, vercelBody, runCli, startServer } from './helpers.mjs';

const KEY = { JEV_API_KEY: 'test-key' };
const Q = { ok: { type: 'boolean', instructions: 'ok?' } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const freshDir = () => mkdtempSync(join(tmpdir(), 'jev-log-'));

function records(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  return files.flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('a successful call appends one full record', async () => {
  const dir = freshDir();
  await withEnv({ ...KEY, JEV_LOG_DIR: dir, JEV_SESSION_ID: 's1' }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    await evaluate({ state: { request: 'x', diff: 'y' }, questions: Q });
  }));
  const [r, ...rest] = records(dir);
  assert.equal(rest.length, 0);
  assert.equal(r.v, 1);
  assert.match(r.id, UUID);
  assert.match(r.ts, ISO);
  assert.match(r.endTs, ISO);
  assert.ok(Date.parse(r.endTs) >= Date.parse(r.ts));
  assert.equal(typeof r.latencyMs, 'number');
  assert.equal(r.session, 's1');
  assert.equal(r.caller, 'module');
  assert.equal(r.provider, 'vercel');
  assert.equal(r.status, 'ok');
  assert.equal(r.requestId, 'gen_test');
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10 });
  assert.deepEqual(r.questions, Q);
  assert.equal(r.answers.ok.probability, 0.9);
  assert.deepEqual(r.state, { request: 'x', diff: 'y' });
  assert.deepEqual(r.stateKeys, ['request', 'diff']);
  assert.equal(r.stateType, 'object');
  assert.match(r.stateHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.stateBytes, Buffer.byteLength(JSON.stringify({ request: 'x', diff: 'y' })));
  assert.equal(r.error, null);
});

test('file name is monthly and UTC-based', () => {
  assert.equal(logFileName(new Date('2026-09-30T23:59:59Z')), 'calls-2026-09.jsonl');
  assert.equal(logFileName(new Date('2026-10-01T00:00:00Z')), 'calls-2026-10.jsonl');
});

test('ids are unique and records append in order', async () => {
  const dir = freshDir();
  await withEnv({ ...KEY, JEV_LOG_DIR: dir }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    for (let i = 0; i < 5; i++) await evaluate({ state: `s${i}`, questions: Q });
  }));
  const rs = records(dir);
  assert.equal(rs.length, 5);
  assert.equal(new Set(rs.map((r) => r.id)).size, 5);
  assert.deepEqual(rs.map((r) => r.state), ['s0', 's1', 's2', 's3', 's4']);
});

test('errors are logged with their code and still thrown', async () => {
  const dir = freshDir();
  await withEnv({ ...KEY, JEV_LOG_DIR: dir }, () => withFetch(() => ({ status: 429, body: { error: { message: 'slow down' } } }), async () => {
    await assert.rejects(evaluate({ state: 'x', questions: Q }), { code: 'rate_limited' });
  }));
  const [r] = records(dir);
  assert.equal(r.status, 'rate_limited');
  assert.equal(r.http, 429);
  assert.equal(r.answers, null);
  assert.match(r.error, /slow down/);
});

test('missing key is logged as auth', async () => {
  const dir = freshDir();
  await withEnv({ JEV_LOG_DIR: dir }, async () => {
    await assert.rejects(evaluate({ state: 'x', questions: Q }), { code: 'auth' });
  });
  assert.equal(records(dir)[0].status, 'auth');
});

test('timeouts are logged', async () => {
  const dir = freshDir();
  const server = await startServer(() => undefined);
  try {
    await withEnv({ ...KEY, JEV_LOG_DIR: dir, JEV_ENDPOINT: server.url }, async () => {
      await assert.rejects(evaluate({ state: 'x', questions: Q, timeoutMs: 50 }), { code: 'timeout' });
    });
  } finally {
    await server.close();
  }
  const [r] = records(dir);
  assert.equal(r.status, 'timeout');
  assert.ok(r.latencyMs >= 40);
});

test('JEV_LOG=meta keeps the hash but drops the state', async () => {
  const dir = freshDir();
  await withEnv({ ...KEY, JEV_LOG_DIR: dir, JEV_LOG: 'meta' }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    await evaluate({ state: 'secret', questions: Q });
  }));
  const [r] = records(dir);
  assert.equal(r.level, 'meta');
  assert.ok(!('state' in r));
  assert.equal(r.stateBytes, 6);
  assert.match(r.stateHash, /^sha256:/);
});

test('retain:false downgrades full logging to meta', async () => {
  const dir = freshDir();
  await withEnv({ ...KEY, JEV_LOG_DIR: dir }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    await evaluate({ state: 'secret', questions: Q, retain: false });
  }));
  const [r] = records(dir);
  assert.equal(r.level, 'meta');
  assert.equal(r.retain, false);
  assert.ok(!('state' in r));
});

test('JEV_LOG=off writes nothing', async () => {
  const dir = freshDir();
  await withEnv({ ...KEY, JEV_LOG_DIR: dir, JEV_LOG: 'off' }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    await evaluate({ state: 'x', questions: Q });
  }));
  assert.deepEqual(readdirSync(dir), []);
});

test('logLevel accepts off aliases and falls back to full', async () => {
  for (const [v, want] of [['0', 'off'], ['false', 'off'], ['OFF', 'off'], ['meta', 'meta'], ['bogus', 'full'], [undefined, 'full']]) {
    await withEnv(v === undefined ? {} : { JEV_LOG: v }, async () => assert.equal(logLevel(), want, String(v)));
  }
});

test('an unwritable log dir never breaks the call', async () => {
  const blocker = join(freshDir(), 'file');
  writeFileSync(blocker, '');
  await withEnv({ ...KEY, JEV_LOG_DIR: join(blocker, 'sub') }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    const r = await evaluate({ state: 'x', questions: Q });
    assert.equal(r.answers.ok.probability, 0.9);
  }));
});

test('log dir resolution order', async () => {
  await withEnv({ JEV_LOG_DIR: '/a', CLAUDE_PLUGIN_DATA: '/b', XDG_STATE_HOME: '/c' }, async () => assert.equal(await logDir(), '/a'));
  await withEnv({ JEV_LOG_DIR: '', CLAUDE_PLUGIN_DATA: '/b', XDG_STATE_HOME: '/c' }, async () => assert.equal(await logDir(), join('/b', 'logs')));
  await withEnv({ JEV_LOG_DIR: '', XDG_STATE_HOME: '/c' }, async () => assert.equal(await logDir(), join('/c', 'jev')));
  await withEnv({ JEV_LOG_DIR: '' }, async () => assert.match(await logDir(), /\.local[/\\]state[/\\]jev$/));
});

test('files are private', { skip: process.platform === 'win32' }, async () => {
  const dir = join(freshDir(), 'nested');
  await withEnv({ ...KEY, JEV_LOG_DIR: dir }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    await evaluate({ state: 'x', questions: Q });
  }));
  const file = join(dir, readdirSync(dir)[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('the CLI logs with caller=cli', async () => {
  const dir = freshDir();
  const server = await startServer((body) => ({ body: vercelBody(body.questions) }));
  try {
    const r = await runCli(['--state', 'x', '--bool', 'ok=ok?'], { env: { ...KEY, JEV_LOG_DIR: dir, JEV_ENDPOINT: server.url } });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    await server.close();
  }
  const [rec] = records(dir);
  assert.equal(rec.caller, 'cli');
  assert.equal(rec.state, 'x');
});

test('concurrent CLI processes do not interleave lines', async () => {
  const dir = freshDir();
  const big = 'z'.repeat(20000);
  const server = await startServer((body) => ({ body: vercelBody(body.questions) }));
  try {
    const runs = await Promise.all(Array.from({ length: 8 }, () =>
      runCli(['--state', big, '--bool', 'ok=ok?'], { env: { ...KEY, JEV_LOG_DIR: dir, JEV_ENDPOINT: server.url } })));
    for (const r of runs) assert.equal(r.code, 0, r.stderr);
  } finally {
    await server.close();
  }
  const rs = records(dir);
  assert.equal(rs.length, 8);
  for (const r of rs) assert.equal(r.state, big);
});
