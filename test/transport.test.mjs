// Transport and provider contract, tested in-process with a stubbed fetch.
// One real local HTTP server case covers the timeout path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, ask, choose, score, JevError, listProviders } from '../skills/jev/scripts/jev.mjs';
import { withFetch, withEnv, vercelBody, startServer } from './helpers.mjs';

const KEY = { JEV_API_KEY: 'test-key' };
const Q = { ok: { type: 'boolean', instructions: 'ok?' } };

async function rejects(fn, code, messageRe) {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected an error');
  assert.ok(err instanceof JevError, `expected JevError, got ${err?.constructor?.name}: ${err?.message}`);
  assert.equal(err.code, code, err.message);
  if (messageRe) assert.match(err.message, messageRe);
  return err;
}

test('listProviders exposes vercel only', () => {
  assert.deepEqual(listProviders(), ['vercel']);
});

test('success is normalised to the canonical shape', async () => {
  await withEnv(KEY, () => withFetch(() => ({ body: vercelBody(Q) }), async (calls) => {
    const r = await evaluate({ state: 'x', questions: Q });
    assert.deepEqual(Object.keys(r).sort(), ['answers', 'requestId', 'usage']);
    assert.equal(r.answers.ok.probability, 0.9);
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10 });
    assert.equal(r.requestId, 'gen_test');
    assert.equal(calls.length, 1);
  }));
});

test('request body carries model, state, questions and bearer auth', async () => {
  await withEnv(KEY, () => withFetch(() => ({ body: vercelBody(Q) }), async (calls) => {
    await evaluate({ state: { a: 1 }, questions: Q });
    const { url, init, body } = calls[0];
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/evaluate');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.deepEqual(body, { model: 'typesafe-ai/jev', state: { a: 1 }, questions: Q });
    assert.ok(!('providerOptions' in body), 'retain defaults to true: no providerOptions');
  }));
});

test('retain:false maps to the provider retention option', async () => {
  await withEnv(KEY, () => withFetch(() => ({ body: vercelBody(Q) }), async (calls) => {
    await evaluate({ state: 'x', questions: Q, retain: false });
    assert.deepEqual(calls[0].body.providerOptions, { gateway: { zeroDataRetention: true } });
  }));
});

test('JEV_ENDPOINT overrides the provider URL', async () => {
  await withEnv({ ...KEY, JEV_ENDPOINT: 'http://localhost:1/x' }, () => withFetch(() => ({ body: vercelBody(Q) }), async (calls) => {
    await evaluate({ state: 'x', questions: Q });
    assert.equal(calls[0].url, 'http://localhost:1/x');
  }));
});

test('missing key fails before any network call with provider-specific help', async () => {
  await withEnv({}, () => withFetch(() => { throw new Error('should not fetch'); }, async (calls) => {
    const err = await rejects(() => evaluate({ state: 'x', questions: Q }), 'auth', /set JEV_API_KEY/);
    assert.match(err.message, /Vercel AI Gateway/);
    assert.equal(calls.length, 0);
  }));
});

test('legacy key env vars are accepted as fallbacks', async () => {
  for (const name of ['AI_GATEWAY_API_KEY', 'VERCEL_AI_GATEWAY_KEY']) {
    await withEnv({ [name]: 'legacy' }, () => withFetch(() => ({ body: vercelBody(Q) }), async (calls) => {
      await evaluate({ state: 'x', questions: Q });
      assert.equal(calls[0].init.headers.Authorization, 'Bearer legacy');
    }));
  }
});

test('unknown provider is rejected before key lookup', async () => {
  await withEnv({}, () => withFetch(() => { throw new Error('should not fetch'); }, async () => {
    const err = await rejects(() => evaluate({ state: 'x', questions: Q, provider: 'bogus' }), 'bad_request', /Unknown provider "bogus"/);
    assert.match(err.message, /Supported: vercel/);
  }));
});

test('provider name is case-insensitive and JEV_PROVIDER is honoured', async () => {
  await withEnv({ ...KEY, JEV_PROVIDER: 'VERCEL' }, () => withFetch(() => ({ body: vercelBody(Q) }), async () => {
    await evaluate({ state: 'x', questions: Q });
    await evaluate({ state: 'x', questions: Q, provider: 'Vercel' });
  }));
});

test('input validation', async () => {
  await withEnv(KEY, async () => {
    await rejects(() => evaluate({ questions: Q }), 'bad_request', /state/);
    await rejects(() => evaluate({ state: 'x', questions: {} }), 'bad_request', /question/);
    await rejects(() => evaluate({ state: 'x' }), 'bad_request', /question/);
  });
});

test('HTTP status codes map to error codes, keeping upstream message', async () => {
  const cases = [[401, 'auth'], [403, 'auth'], [429, 'rate_limited'], [400, 'bad_request'], [404, 'bad_request'], [500, 'unavailable'], [503, 'unavailable']];
  for (const [status, code] of cases) {
    await withEnv(KEY, () => withFetch(() => ({ status, body: { error: { message: `upstream ${status}` } } }), async () => {
      const err = await rejects(() => evaluate({ state: 'x', questions: Q }), code, new RegExp(`\\(${code}\\): upstream ${status}`));
      assert.equal(err.status, status);
    }));
  }
});

test('non-JSON error body is surfaced as text', async () => {
  await withEnv(KEY, () => withFetch(() => ({ status: 502, body: 'Bad Gateway' }), async () => {
    await rejects(() => evaluate({ state: 'x', questions: Q }), 'unavailable', /Bad Gateway/);
  }));
});

test('error body with HTTP 200 is detected via extractError', async () => {
  await withEnv(KEY, () => withFetch(() => ({ status: 200, body: { error: { message: 'quota exceeded' } } }), async () => {
    await rejects(() => evaluate({ state: 'x', questions: Q }), 'unknown', /quota exceeded/);
  }));
});

test('success body without answers is an unknown error', async () => {
  await withEnv(KEY, () => withFetch(() => ({ status: 200, body: { hello: 'world' } }), async () => {
    await rejects(() => evaluate({ state: 'x', questions: Q }), 'unknown', /unexpected response/);
  }));
});

test('network failure maps to unavailable with cause', async () => {
  await withEnv(KEY, () => withFetch(() => { throw new TypeError('fetch failed'); }, async () => {
    const err = await rejects(() => evaluate({ state: 'x', questions: Q }), 'unavailable', /Could not reach/);
    assert.equal(err.cause?.message, 'fetch failed');
  }));
});

test('timeout aborts a hanging server and maps to timeout', async () => {
  const server = await startServer(() => undefined);
  try {
    await withEnv({ ...KEY, JEV_ENDPOINT: server.url }, async () => {
      const started = Date.now();
      await rejects(() => evaluate({ state: 'x', questions: Q, timeoutMs: 100 }), 'timeout', /within 100 ms/);
      assert.ok(Date.now() - started < 2000, 'aborted promptly');
    });
  } finally {
    await server.close();
  }
});

test('ask/choose/score helpers unwrap the single answer', async () => {
  const qs = {
    q: { type: 'boolean', instructions: 'b?' },
  };
  await withEnv(KEY, async () => {
    await withFetch(() => ({ body: vercelBody(qs) }), async (calls) => {
      assert.equal(await ask('s', 'b?'), 0.9);
      assert.ok(!('criteria' in calls[0].body.questions.q));
      assert.deepEqual((await (async () => { await ask('s', 'b?', { true: 't', false: 'f' }); return calls[1].body.questions.q.criteria; })()), { true: 't', false: 'f' });
    });
    await withFetch((_, init) => ({ body: vercelBody(JSON.parse(init.body).questions) }), async (calls) => {
      const c = await choose('s', 'which?', { a: 'A', b: 'B' });
      assert.equal(c.type, 'choice');
      assert.equal(c.choice, 'a');
      assert.deepEqual(calls[0].body.questions.q, { type: 'choice', instructions: 'which?', criteria: { a: 'A', b: 'B' } });
      const s = await score('s', 'how?', ['lo', 'mid', 'hi']);
      assert.equal(s.type, 'score');
      assert.equal(s.score, 1);
      assert.deepEqual(calls[1].body.questions.q.criteria, ['lo', 'mid', 'hi']);
    });
  });
});

test('JevError carries name, code, status and cause', () => {
  const e = new JevError('auth', 'm', { status: 401, cause: { x: 1 } });
  assert.equal(e.name, 'JevError');
  assert.equal(e.code, 'auth');
  assert.equal(e.status, 401);
  assert.deepEqual(e.cause, { x: 1 });
  assert.ok(e instanceof Error);
  const plain = new JevError('unknown', 'm');
  assert.ok(!('status' in plain));
});
