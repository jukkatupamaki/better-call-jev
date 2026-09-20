import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPT = join(ROOT, 'skills', 'jev', 'scripts', 'jev.mjs');

/** A canned Vercel-shaped success body for the given question keys/types. */
export function vercelBody(questions, extra = {}) {
  const answers = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'boolean') answers[k] = { type: 'boolean', probability: 0.9 };
    else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      answers[k] = { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((o, i) => [o, i === 0 ? 1 : 0])), confidence: 1 };
    } else if (q.type === 'score') {
      answers[k] = { type: 'score', score: 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0])), confidence: 1 };
    }
  }
  return {
    model: 'typesafe-ai/jev',
    answers,
    usage: { inputTokens: 100, outputTokens: 10 },
    providerMetadata: { gateway: { generationId: 'gen_test' } },
    ...extra,
  };
}

/**
 * Replace globalThis.fetch for the duration of `fn`. `handler` receives (url, init)
 * and returns { status, body } (body is JSON-serialised) or throws to simulate a
 * network error.
 */
export async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    const r = await handler(String(url), init);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Run `fn` with process.env replaced by `env` (plus PATH), restoring afterwards. */
export async function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, { PATH: saved.PATH }, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/**
 * Start a local HTTP server that answers every POST with `respond(body)`.
 * If `respond` returns undefined the request is left hanging (for timeout tests).
 * Returns { url, requests, close }.
 */
export async function startServer(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ headers: req.headers, body });
      const r = respond(body, req);
      if (r === undefined) return; // hang
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/evaluate`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** Spawn the CLI. Returns { code, stdout, stderr, json } where json is parsed stdout or null. */
export function runCli(args, { stdin, env = {}, script = SCRIPT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not json */ }
      resolve({ code, stdout, stderr, json });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
