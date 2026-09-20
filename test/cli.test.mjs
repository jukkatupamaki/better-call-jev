// CLI behaviour, tested by spawning the real script against a local HTTP server
// (via JEV_ENDPOINT) so argument parsing, stdin modes, output and exit codes are
// exercised end to end without network access.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, startServer, vercelBody } from './helpers.mjs';

let server;
let env;
let tmp;

before(async () => {
  server = await startServer((body) => ({ body: vercelBody(body.questions) }));
  env = { JEV_API_KEY: 'k', JEV_ENDPOINT: server.url };
  tmp = mkdtempSync(join(tmpdir(), 'jev-cli-'));
});

after(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

const lastBody = () => server.requests.at(-1).body;

test('--help prints usage and exits 0 without a key', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--provider <name>/);
  assert.match(r.stdout, /JEV_API_KEY \(required\)/);
  const r2 = await runCli(['-h']);
  assert.equal(r2.code, 0);
});

test('--bool with default key and inline --state', async () => {
  const r = await runCli(['--state', 'hello', '--bool', 'fine?'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json), ['q1']);
  assert.equal(r.json.q1.type, 'boolean');
  assert.deepEqual(lastBody().questions, { q1: { type: 'boolean', instructions: 'fine?' } });
  assert.equal(lastBody().state, 'hello');
});

test('key=instructions names the question; mixed named and default keys', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'refund=Money back?', '--bool', 'second?'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(lastBody().questions).sort(), ['q2', 'refund']);
  assert.equal(lastBody().questions.refund.instructions, 'Money back?');
});

test('--choice with --options parses name=desc pairs and bare names', async () => {
  const r = await runCli(['--state', 'x', '--choice', 'route=Route it', '--options', 'billing=charges and refunds,shipping=delivery,other'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lastBody().questions.route, {
    type: 'choice',
    instructions: 'Route it',
    criteria: { billing: 'charges and refunds', shipping: 'delivery', other: 'other' },
  });
  assert.equal(r.json.route.type, 'choice');
});

test('--choice without --options is an error', async () => {
  const r = await runCli(['--state', 'x', '--choice', 'which?'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--choice requires --options/);
});

test('--score with --scale builds an ordered rubric', async () => {
  const r = await runCli(['--state', 'x', '--score', 'risk=How risky?', '--scale', 'low, medium ,high'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lastBody().questions.risk, { type: 'score', instructions: 'How risky?', criteria: ['low', 'medium', 'high'] });
  assert.equal(r.json.risk.type, 'score');
});

test('--score without --scale is an error', async () => {
  const r = await runCli(['--state', 'x', '--score', 'how?'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--score requires --scale/);
});

test('--questions merges a raw object with flag-built questions', async () => {
  const raw = JSON.stringify({ extra: { type: 'boolean', instructions: 'e?', criteria: { true: 't', false: 'f' } } });
  const r = await runCli(['--state', 'x', '--bool', 'a?', '--questions', raw], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(lastBody().questions).sort(), ['extra', 'q1']);
  assert.deepEqual(lastBody().questions.extra.criteria, { true: 't', false: 'f' });
});

test('--state-json sends structured state', async () => {
  const r = await runCli(['--state-json', '{"a":[1,2]}', '--bool', 'ok?'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lastBody().state, { a: [1, 2] });
});

test('--state-file reads text, and parses .json files as structured state', async () => {
  const txt = join(tmp, 'state.txt');
  const js = join(tmp, 'state.json');
  writeFileSync(txt, 'plain text\n');
  writeFileSync(js, '{"k":"v"}');
  let r = await runCli(['--state-file', txt, '--bool', 'ok?'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastBody().state, 'plain text\n');
  r = await runCli(['--state-file', js, '--bool', 'ok?'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lastBody().state, { k: 'v' });
});

test('more than one state source is rejected', async () => {
  const r = await runCli(['--state', 'a', '--state-json', '{}', '--bool', 'ok?'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only one of --state/);
});

test('stdin with question flags is the state text', async () => {
  const r = await runCli(['--bool', 'ok?'], { env, stdin: 'from stdin\nline 2' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastBody().state, 'from stdin\nline 2');
});

test('stdin without question flags is a full request', async () => {
  const req = { state: { n: 1 }, questions: { done: { type: 'boolean', instructions: 'done?' } } };
  const r = await runCli([], { env, stdin: JSON.stringify(req) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lastBody().state, { n: 1 });
  assert.deepEqual(Object.keys(r.json), ['done']);
});

test('malformed JSON on stdin in full-request mode exits 1', async () => {
  const r = await runCli([], { env, stdin: '{not json' });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.length > 0);
});

test('--state-file pointing at a missing file exits 1', async () => {
  const r = await runCli(['--state-file', join(tmp, 'nope.txt'), '--bool', 'ok?'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ENOENT|no such file/i);
});

test('empty stdin and no state is an error', async () => {
  const r = await runCli(['--bool', 'ok?'], { env, stdin: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No state given/);
});

test('unknown arguments are rejected with usage', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'ok?', '--wat'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown arguments: --wat/);
  assert.match(r.stderr, /Usage:/);
});

test('--verbose prints answers, usage and requestId', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'ok?', '--verbose'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.json).sort(), ['answers', 'requestId', 'usage']);
  assert.equal(r.json.requestId, 'gen_test');
});

test('default output is answers only', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'ok?'], { env });
  assert.ok(!('usage' in r.json));
  assert.ok(!('answers' in r.json));
});

test('--no-retain is passed to the provider', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'ok?', '--no-retain'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lastBody().providerOptions, { gateway: { zeroDataRetention: true } });
});

test('--timeout validation', async () => {
  for (const bad of ['abc', '0', '-5']) {
    const r = await runCli(['--state', 'x', '--bool', 'ok?', '--timeout', bad], { env });
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /--timeout must be a positive number/);
  }
});

test('--timeout is honoured against a hanging server', async () => {
  const hang = await startServer(() => undefined);
  try {
    const r = await runCli(['--state', 'x', '--bool', 'ok?', '--timeout', '100'], { env: { JEV_API_KEY: 'k', JEV_ENDPOINT: hang.url } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did not answer within 100 ms/);
  } finally {
    await hang.close();
  }
});

test('JEV_TIMEOUT_MS sets the default timeout', async () => {
  const hang = await startServer(() => undefined);
  try {
    const r = await runCli(['--state', 'x', '--bool', 'ok?'], { env: { JEV_API_KEY: 'k', JEV_ENDPOINT: hang.url, JEV_TIMEOUT_MS: '120' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did not answer within 120 ms/);
  } finally {
    await hang.close();
  }
});

test('--provider unknown fails with the supported list', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'ok?', '--provider', 'nope'], { env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown provider "nope". Supported: vercel/);
});

test('missing key exits 1 with setup instructions and no request', async () => {
  const before = server.requests.length;
  const r = await runCli(['--state', 'x', '--bool', 'ok?'], { env: { JEV_ENDPOINT: server.url } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Missing API key: set JEV_API_KEY/);
  assert.match(r.stderr, /Vercel dashboard/);
  assert.equal(server.requests.length, before);
  assert.equal(r.stdout, '');
});

test('gateway error is reported with code and exit 1', async () => {
  const failing = await startServer(() => ({ status: 401, body: { error: { message: 'Authentication failed' } } }));
  try {
    const r = await runCli(['--state', 'x', '--bool', 'ok?'], { env: { JEV_API_KEY: 'bad', JEV_ENDPOINT: failing.url } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Jev request failed \(auth\): Authentication failed/);
    assert.equal(r.stdout, '');
  } finally {
    await failing.close();
  }
});

test('bearer token is sent', async () => {
  await runCli(['--state', 'x', '--bool', 'ok?'], { env });
  assert.equal(server.requests.at(-1).headers.authorization, 'Bearer k');
});

test('boolean answers carry a verdict under the default 0.8 / 0.2 thresholds', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'ok?'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).q1.verdict, 'yes'); // stub returns 0.9
});

test('--thresholds and env override the defaults', async () => {
  const r = await runCli(['--state', 'x', '--bool', 'ok?', '--thresholds', '0.95,0.1'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).q1.verdict, 'undecided');
  const r2 = await runCli(['--state', 'x', '--bool', 'ok?'], { env: { ...env, JEV_THRESHOLD_HIGH: '0.95' } });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).q1.verdict, 'undecided');
  const r3 = await runCli(['--state', 'x', '--bool', 'ok?', '--thresholds', '0.5,0.1'], { env: { ...env, JEV_THRESHOLD_HIGH: '0.95' } });
  assert.equal(JSON.parse(r3.stdout).q1.verdict, 'yes'); // flag beats env
});

test('--thresholds validation', async () => {
  for (const bad of ['0.8', 'abc,0.2', '0.2,0.8', '1.5,0.2']) {
    const r = await runCli(['--state', 'x', '--bool', 'ok?', '--thresholds', bad], { env });
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /[Tt]hreshold/);
  }
});
