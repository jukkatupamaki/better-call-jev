#!/usr/bin/env node
// Lightweight client for TypeSafe AI's Jev evaluation model.
// Zero dependencies. Requires Node 18+ (global fetch).
// Usable as a CLI or as an ES module (`import { evaluate } from './jev.mjs'`).
//
// The transport (currently Vercel AI Gateway) is an implementation detail
// confined to the "Transport" section below. Nothing caller-facing names it.

// Transport --------------------------------------------------------------------

const ENDPOINT = process.env.JEV_ENDPOINT || 'https://ai-gateway.vercel.sh/v1/evaluate';
const MODEL_SLUG = 'typesafe-ai/jev';
const DEFAULT_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS) || 8000;

function apiKey() {
  const key = process.env.JEV_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY;
  if (!key) {
    throw new JevError(
      'auth',
      'Missing API key: set JEV_API_KEY. Jev is served through Vercel AI Gateway; create an API key in the Vercel dashboard under AI Gateway and export it as JEV_API_KEY.',
    );
  }
  return key;
}

function classify(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'bad_request';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

async function transport({ state, questions, retain, timeoutMs }) {
  const body = { model: MODEL_SLUG, state, questions };
  if (retain === false) body.providerOptions = { gateway: { zeroDataRetention: true } };

  const key = apiKey();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
      throw new JevError('timeout', `Jev did not answer within ${timeoutMs} ms.`, { cause });
    }
    throw new JevError('unavailable', 'Could not reach the Jev service.', { cause });
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const upstream = data?.error?.message || data?.message || text;
    const code = classify(res.status);
    throw new JevError(code, `Jev request failed (${code}): ${upstream}`, { status: res.status, cause: data ?? text });
  }
  if (!data?.answers) {
    throw new JevError('unknown', 'Jev returned an unexpected response.', { cause: data ?? text });
  }

  return {
    answers: data.answers,
    usage: {
      inputTokens: data.usage?.inputTokens ?? null,
      outputTokens: data.usage?.outputTokens ?? null,
    },
    requestId: data.providerMetadata?.gateway?.generationId ?? null,
  };
}

// Public API ---------------------------------------------------------------------

export class JevError extends Error {
  /** @param {'auth'|'bad_request'|'rate_limited'|'unavailable'|'timeout'|'unknown'} code */
  constructor(code, message, { status, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'JevError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Evaluate `state` against typed `questions`.
 *
 * @param {object} opts
 * @param {string|object|any[]} opts.state          What is being judged: text, object, or array.
 * @param {Record<string, Question>} opts.questions Keyed questions. Types: boolean | choice | score.
 * @param {boolean} [opts.retain=true]              false asks the service not to retain the input (best effort).
 * @param {number}  [opts.timeoutMs=8000]           Abort and throw JevError('timeout') after this many ms. Env JEV_TIMEOUT_MS sets the default.
 * @returns {Promise<{ answers: Record<string, Answer>, usage: { inputTokens: number|null, outputTokens: number|null }, requestId: string|null }>}
 * @throws {JevError}
 *
 * @typedef {{ type: 'boolean', instructions: string, criteria?: { true: string, false: string } }
 *         | { type: 'choice',  instructions: string, criteria: Record<string, string> }
 *         | { type: 'score',   instructions: string, criteria: string[] }} Question
 * @typedef {{ type: 'boolean', probability: number }
 *         | { type: 'choice',  choice: string, probabilities: Record<string, number>, confidence: number }
 *         | { type: 'score',   score: number,  probabilities: Record<string, number>, confidence: number }} Answer
 */
export async function evaluate({ state, questions, retain = true, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (state === undefined) throw new JevError('bad_request', '`state` is required.');
  if (!questions || Object.keys(questions).length === 0) {
    throw new JevError('bad_request', 'At least one question is required.');
  }
  return transport({ state, questions, retain, timeoutMs });
}

/** Boolean question → probability of true (0..1). `criteria` is optional { true, false }. */
export async function ask(state, instructions, criteria) {
  const q = { type: 'boolean', instructions };
  if (criteria) q.criteria = criteria;
  const r = await evaluate({ state, questions: { q } });
  return r.answers.q.probability;
}

/** Choice question → { choice, probabilities, confidence }. `options` is { name: description }. */
export async function choose(state, instructions, options) {
  const r = await evaluate({ state, questions: { q: { type: 'choice', instructions, criteria: options } } });
  return r.answers.q;
}

/** Score question → { score, probabilities, confidence }. `scale` is ordered lowest → highest. */
export async function score(state, instructions, scale) {
  const r = await evaluate({ state, questions: { q: { type: 'score', instructions, criteria: scale } } });
  return r.answers.q;
}

// CLI ------------------------------------------------------------------------------

const USAGE = `Usage:
  jev.mjs [state] <question flags> [--verbose] [--no-retain]
  echo '{"state": ..., "questions": {...}}' | jev.mjs        (full request on stdin)

State (give exactly one; if none, stdin is used):
  --state <text>            Inline text
  --state-file <path>       File contents; a path ending in .json is parsed as structured state
  --state-json <json>       Structured state inline
  (stdin)                   With question flags: stdin is the state text.
                            Without question flags: stdin is a full request {state, questions}.

Questions (repeatable; keys default to q1, q2, ... unless written as key=instructions):
  --bool   "[key=]<instructions>"
  --choice "[key=]<instructions>" --options "a=desc a,b=desc b"   (plain "a,b" uses names as descriptions)
  --score  "[key=]<instructions>" --scale  "low,medium,high"       (labels only, lowest → highest)
  --questions <json>        Raw questions object, merged with the flags above
  Note: --options and --scale are comma-separated; commas inside a description are not supported.

Options:
  --verbose                 Print { answers, usage, requestId } instead of just answers
  --no-retain               Ask the service not to retain the input (best effort)
  --timeout <ms>            Give up after this many ms (default ${DEFAULT_TIMEOUT_MS}, env JEV_TIMEOUT_MS)
  -h, --help

Env: JEV_API_KEY (required), JEV_TIMEOUT_MS (optional)

Exit codes: 0 ok, 1 error (message on stderr)`;

function parseKV(s) {
  const out = {};
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) out[part.trim()] = part.trim();
    else out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function splitKey(s, fallback) {
  const m = /^([A-Za-z_][\w-]*)=(.+)$/s.exec(s);
  return m ? [m[1], m[2]] : [fallback, s];
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const args = [...argv];
  const next = (flag) => {
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

  if (has('-h') || has('--help')) { console.log(USAGE); return; }

  const verbose = has('--verbose');
  const retain = !has('--no-retain');
  const timeoutArg = next('--timeout');
  const timeoutMs = timeoutArg !== undefined ? Number(timeoutArg) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout must be a positive number of milliseconds');

  // Questions
  const questions = {};
  let n = 0;
  let v;
  while ((v = next('--bool')) !== undefined) {
    const [key, instructions] = splitKey(v, `q${++n}`);
    questions[key] = { type: 'boolean', instructions };
  }
  while ((v = next('--choice')) !== undefined) {
    const [key, instructions] = splitKey(v, `q${++n}`);
    const opts = next('--options');
    if (!opts) throw new Error('--choice requires --options "a=desc,b=desc"');
    questions[key] = { type: 'choice', instructions, criteria: parseKV(opts) };
  }
  while ((v = next('--score')) !== undefined) {
    const [key, instructions] = splitKey(v, `q${++n}`);
    const scale = next('--scale');
    if (!scale) throw new Error('--score requires --scale "low,medium,high"');
    questions[key] = { type: 'score', instructions, criteria: scale.split(',').map((s) => s.trim()) };
  }
  const qjson = next('--questions');
  if (qjson) Object.assign(questions, JSON.parse(qjson));

  // State
  const sText = next('--state');
  const sFile = next('--state-file');
  const sJson = next('--state-json');
  const given = [sText, sFile, sJson].filter((x) => x !== undefined).length;
  if (given > 1) throw new Error('Give only one of --state, --state-file, --state-json.');

  let state;
  if (sJson !== undefined) state = JSON.parse(sJson);
  else if (sFile !== undefined) {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(sFile, 'utf8');
    state = sFile.endsWith('.json') ? JSON.parse(content) : content;
  } else if (sText !== undefined) state = sText;
  else {
    const stdin = await readStdin();
    if (!stdin.trim()) throw new Error('No state given. See --help.');
    if (Object.keys(questions).length === 0) {
      const req = JSON.parse(stdin);
      state = req.state;
      Object.assign(questions, req.questions || {});
    } else {
      state = stdin;
    }
  }

  if (args.length) throw new Error(`Unknown arguments: ${args.join(' ')}\n\n${USAGE}`);

  const result = await evaluate({ state, questions, retain, timeoutMs });
  console.log(JSON.stringify(verbose ? result : result.answers, null, 2));
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
