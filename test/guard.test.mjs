// In-process guards: concurrency cap and rate-limit circuit breaker.
// Own file because the breaker state is per process; each case leaves it closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../skills/jev/scripts/jev.mjs';
import { withEnv, vercelBody } from './helpers.mjs';

const Q = { ok: { type: 'boolean', instructions: 'ok?' } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stub fetch with a handler returning a Response; tracks in-flight and total requests. */
async function withStub(handler, fn) {
  const original = globalThis.fetch;
  const stats = { inFlight: 0, maxInFlight: 0, requests: 0 };
  globalThis.fetch = async (...args) => {
    stats.requests++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try { return await handler(stats, ...args); } finally { stats.inFlight--; }
  };
  try { return await fn(stats); } finally { globalThis.fetch = original; }
}

const ok = async () => { await sleep(10); return new Response(JSON.stringify(vercelBody(Q)), { status: 200 }); };
const limited = (headers = {}) => async () => new Response(JSON.stringify({ error: { message: 'too many' } }), { status: 429, headers });

test('Promise.all over 150 calls keeps at most 4 in flight and all succeed', async () => {
  await withEnv({ JEV_API_KEY: 'k' }, () => withStub(ok, async (stats) => {
    const rs = await Promise.all(Array.from({ length: 150 }, (_, i) => evaluate({ state: `s${i}`, questions: Q })));
    assert.equal(rs.length, 150);
    assert.equal(stats.requests, 150);
    assert.equal(stats.maxInFlight, 4);
  }));
});

test('JEV_CONCURRENCY changes the cap; invalid values fall back to 4', async () => {
  for (const [v, want] of [['2', 2], ['1', 1], ['0', 4], ['abc', 4]]) {
    await withEnv({ JEV_API_KEY: 'k', JEV_CONCURRENCY: v }, () => withStub(ok, async (stats) => {
      await Promise.all(Array.from({ length: 12 }, () => evaluate({ state: 'x', questions: Q })));
      assert.equal(stats.maxInFlight, want, `JEV_CONCURRENCY=${v}`);
    }));
  }
});

test('a 429 stops the rest of a burst without sending, then recovers after the cooldown', async () => {
  await withEnv({ JEV_API_KEY: 'k', JEV_COOLDOWN_MS: '300' }, async () => {
    await withStub(limited(), async (stats) => {
      const settled = await Promise.allSettled(Array.from({ length: 150 }, () => evaluate({ state: 'x', questions: Q })));
      assert.ok(settled.every((s) => s.status === 'rejected' && s.reason.code === 'rate_limited'));
      assert.ok(stats.requests <= 4, `sent ${stats.requests} requests, expected only the first in-flight batch`);
      const shortCircuited = settled.filter((s) => /not sending/.test(s.reason.message));
      assert.ok(shortCircuited.length >= 146);
      assert.match(shortCircuited[0].reason.message, /Do not retry/);
    });
    await sleep(350);
    await withStub(ok, async (stats) => {
      await evaluate({ state: 'x', questions: Q });
      assert.equal(stats.requests, 1);
    });
  });
});

test('Retry-After overrides the cooldown', async () => {
  await withEnv({ JEV_API_KEY: 'k', JEV_COOLDOWN_MS: '60000' }, async () => {
    await withStub(limited({ 'retry-after': '0' }), async () => {
      await assert.rejects(evaluate({ state: 'x', questions: Q }), { code: 'rate_limited' });
    });
    await withStub(ok, async (stats) => {
      await evaluate({ state: 'x', questions: Q });
      assert.equal(stats.requests, 1);
    });
  });
});

test('other errors do not open the breaker', async () => {
  await withEnv({ JEV_API_KEY: 'k', JEV_COOLDOWN_MS: '60000' }, async () => {
    await withStub(async () => new Response('{}', { status: 503 }), async () => {
      await assert.rejects(evaluate({ state: 'x', questions: Q }), { code: 'unavailable' });
    });
    await withStub(ok, async (stats) => {
      await evaluate({ state: 'x', questions: Q });
      assert.equal(stats.requests, 1);
    });
  });
});

test('slots are released after errors', async () => {
  await withEnv({ JEV_API_KEY: 'k', JEV_CONCURRENCY: '2' }, async () => {
    await withStub(async () => new Response('{}', { status: 500 }), async () => {
      await Promise.allSettled(Array.from({ length: 10 }, () => evaluate({ state: 'x', questions: Q })));
    });
    await withStub(ok, async (stats) => {
      await Promise.all(Array.from({ length: 6 }, () => evaluate({ state: 'x', questions: Q })));
      assert.equal(stats.maxInFlight, 2);
    });
  });
});
