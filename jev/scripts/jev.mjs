#!/usr/bin/env node
// Lightweight wrapper for TypeSafe AI's Jev evaluation model via Vercel AI Gateway.
// Zero dependencies. Requires Node 18+ (global fetch).
//
// Usable as a CLI or as an ES module (`import { evaluate } from './jev.mjs'`).

const GATEWAY_URL = process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1/evaluate';
const MODEL = process.env.JEV_MODEL || 'typesafe-ai/jev';

function apiKey() {
  const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY;
  if (!key) {
    throw new Error('Missing API key: set AI_GATEWAY_API_KEY (or VERCEL_AI_GATEWAY_KEY).');
  }
  return key;
}

/**
 * Evaluate `state` against typed `questions`.
 *
 * @param {object} opts
 * @param {string|object|any[]} opts.state       The shared state to evaluate (text, object, or array).
 * @param {Record<string, Question>} opts.questions  Keyed questions. Types: boolean | choice | score.
 * @param {object} [opts.providerOptions]        Passed through, e.g. { gateway: { zeroDataRetention: true } }.
 * @param {string} [opts.model]                  Defaults to typesafe-ai/jev.
 * @returns {Promise<{ model: string, answers: Record<string, Answer>, usage: object, providerMetadata: object }>}
 *
 * @typedef {{ type: 'boolean', instructions: string, criteria?: { true: string, false: string } }
 *         | { type: 'choice',  instructions: string, criteria: Record<string, string> }
 *         | { type: 'score',   instructions: string, criteria: string[] }} Question
 * @typedef {{ type: 'boolean', probability: number }
 *         | { type: 'choice',  choice: string, probabilities: Record<string, number> }
 *         | { type: 'score',   score: number,  probabilities: Record<string, number> }} Answer
 */
export async function evaluate({ state, questions, providerOptions, model = MODEL }) {
  if (state === undefined) throw new Error('`state` is required.');
  if (!questions || Object.keys(questions).length === 0) throw new Error('At least one question is required.');

  const body = { model, state, questions };
  if (providerOptions) body.providerOptions = providerOptions;

  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text;
    throw new Error(`Gateway error ${res.status}: ${msg}`);
  }
  return data;
}

// Convenience helpers -------------------------------------------------------

/** Boolean question → probability of true (0..1). */
export async function ask(state, instructions, criteria) {
  const q = { type: 'boolean', instructions };
  if (criteria) q.criteria = criteria;
  const r = await evaluate({ state, questions: { q } });
  return r.answers.q.probability;
}

/** Choice question → { choice, probabilities }. `options` is { name: description }. */
export async function choose(state, instructions, options) {
  const r = await evaluate({ state, questions: { q: { type: 'choice', instructions, criteria: options } } });
  return r.answers.q;
}

/** Score question → { score, probabilities }. `scale` is ordered lowest → highest. */
export async function score(state, instructions, scale) {
  const r = await evaluate({ state, questions: { q: { type: 'score', instructions, criteria: scale } } });
  return r.answers.q;
}

// CLI -----------------------------------------------------------------------

const USAGE = `Usage:
  jev.mjs --state <text> [--state-file <path>] <question flags> [--raw] [--zdr]
  echo '{"state": ..., "questions": {...}}' | jev.mjs        (full request on stdin)

State (one of):
  --state <text>            Inline text
  --state-file <path>       File contents (JSON files are parsed as structured state)
  --state-json <json>       Structured state as JSON
  (stdin)                   If no --state* flag: stdin is either a full request JSON
                            ({state, questions}) or, when question flags are given, raw state text

Questions (repeatable, each gets key q1, q2, ... unless prefixed with key=):
  --bool   "[key=]<instructions>"                       boolean → probability
  --choice "[key=]<instructions>" --options a=desc,b=desc   choice  → choice + probabilities
  --score  "[key=]<instructions>" --scale low,mid,high      score   → score + probabilities
  --questions <json>        Raw questions object (advanced / mixed)

Options:
  --raw                     Print full gateway response (usage, cost, routing)
  --zdr                     Request zero data retention
  --model <id>              Override model (default ${MODEL})
  -h, --help

Env: AI_GATEWAY_API_KEY or VERCEL_AI_GATEWAY_KEY (required)`;

function parseKV(s) {
  // "a=desc a,b=desc b" → { a: 'desc a', b: 'desc b' }; plain "a,b" → { a: 'a', b: 'b' }
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

  const raw = has('--raw');
  const zdr = has('--zdr');
  const model = next('--model') || MODEL;

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
    if (!opts) throw new Error('--choice requires --options a=desc,b=desc');
    questions[key] = { type: 'choice', instructions, criteria: parseKV(opts) };
  }
  while ((v = next('--score')) !== undefined) {
    const [key, instructions] = splitKey(v, `q${++n}`);
    const scale = next('--scale');
    if (!scale) throw new Error('--score requires --scale low,mid,high');
    questions[key] = { type: 'score', instructions, criteria: scale.split(',').map((s) => s.trim()) };
  }
  const qjson = next('--questions');
  if (qjson) Object.assign(questions, JSON.parse(qjson));

  // State
  let state;
  const sText = next('--state');
  const sFile = next('--state-file');
  const sJson = next('--state-json');
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

  const providerOptions = zdr ? { gateway: { zeroDataRetention: true } } : undefined;
  const result = await evaluate({ state, questions, providerOptions, model });
  console.log(JSON.stringify(raw ? result : result.answers, null, 2));
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
