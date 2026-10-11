// Sensitive-data check: requests that look like they carry credentials or card
// numbers are refused before anything is sent, and never written to the log.
// Fake secrets are assembled at runtime so the source never contains one verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, findSensitive } from '../skills/jev/scripts/jev.mjs';
import { withEnv, withFetch, vercelBody, runCli } from './helpers.mjs';

const Q = { ok: { type: 'boolean', instructions: 'ok?' } };
const j = (...parts) => parts.join('');
const A = (n) => 'A1b2C3d4E5'.repeat(8).slice(0, n);

const SECRETS = {
  'private key': j('-----BEGIN RSA ', 'PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----'),
  'AWS access key': j('AKIA', 'IOSFODNN7EXAMPLE'),
  'GitHub token': j('ghp_', A(36)),
  'Slack token': j('xoxb-', '1234567890-abcdefghij'),
  'API key': j('sk-', 'ant-', A(40)),
  'Stripe key': j('sk_', 'live_', A(24)),
  'Google API key': j('AIza', A(35)),
  JWT: j('eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  'password or secret assignment': j('DB_PASS', 'WORD="hunter2', 'hunter2"'),
  'card number': j('4111 1111', ' 1111 1111'),
};

for (const [kind, secret] of Object.entries(SECRETS)) {
  test(`detects ${kind}`, () => {
    const found = findSensitive({ diff: `+ const x = 1;\n+ ${secret}\n` });
    assert.ok(found.some((f) => f.kind === kind && f.path === 'diff'), JSON.stringify(found));
  });
}

test('reports nested paths, keys and questions, never the matched text', () => {
  const secret = SECRETS['GitHub token'];
  const found = findSensitive({ state: { files: [{ body: 'ok' }, { body: secret }] }, questions: { q: { type: 'boolean', instructions: `is ${secret} valid?` } } });
  assert.deepEqual(found.map((f) => f.path), ['state.files[1].body', 'questions.q.instructions']);
  assert.ok(!JSON.stringify(found).includes(secret));
  assert.match(findSensitive({ [secret]: 1 })[0].path, /\(key\)$/);
});

test('ordinary code and text pass', () => {
  const clean = [
    'const password: string = input.value;',
    'apiKey = process.env.OPENAI_API_KEY',
    'API_KEY=<redacted>',
    'secret: ${SECRET}',
    'password = "changeme123"',
    'client_secret: "your-client-secret-1"',
    'token = getToken(); secretKey: secretKey,',
    'Date.now() === 1727000000000',
    'order id 4111111111111112 (fails Luhn)',
    'const sk = "sk-short";',
    'git commit -m "Fix login"',
    'Jukka Tupamäki <jukka@example.com>',
  ];
  for (const s of clean) assert.deepEqual(findSensitive({ s }), [], s);
});

test('a sensitive request is refused before any network call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-sens-'));
  const secret = SECRETS['AWS access key'];
  await withEnv({ JEV_API_KEY: 'k', JEV_LOG_DIR: dir, JEV_SESSION_ID: 's' }, () => withFetch(() => ({ body: vercelBody(Q) }), async (calls) => {
    const err = await evaluate({ state: { diff: secret }, questions: Q }).catch((e) => e);
    assert.equal(err.code, 'sensitive');
    assert.match(err.message, /^Refused to send \(sensitive\).*AWS access key in state\.diff.*Nothing was sent/);
    assert.ok(!err.message.includes(secret));
    assert.equal(calls.length, 0);
  }));
  const text = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
  assert.ok(!text.includes(secret), 'secret never reaches the local log');
  const rec = JSON.parse(text.trim());
  assert.deepEqual(Object.keys(rec).sort(), ['caller', 'findings', 'id', 'session', 'status', 'ts', 'v']);
  assert.equal(rec.status, 'sensitive');
  assert.deepEqual(rec.findings, [{ path: 'state.diff', kind: 'AWS access key' }]);
});

test('JEV_ALLOW_SENSITIVE=1 lets the user override the check', async () => {
  await withEnv({ JEV_API_KEY: 'k', JEV_ALLOW_SENSITIVE: '1' }, () => withFetch(() => ({ body: vercelBody(Q) }), async (calls) => {
    await evaluate({ state: SECRETS['Stripe key'], questions: Q });
    assert.equal(calls.length, 1);
  }));
});

test('the CLI exits 1 with the sensitive message', async () => {
  const r = await runCli(['--state', `token ${SECRETS['GitHub token']}`, '--bool', 'ok=ok?'], { env: { JEV_API_KEY: 'k', JEV_ENDPOINT: 'http://127.0.0.1:1/x' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Refused to send \(sensitive\): .*GitHub token in state\)\. Nothing was sent/);
});

test('many findings are capped in the message', () => {
  const state = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, SECRETS['AWS access key']]));
  return withEnv({ JEV_API_KEY: 'k' }, async () => {
    const err = await evaluate({ state, questions: Q }).catch((e) => e);
    assert.match(err.message, /and 3 more/);
    assert.equal(err.findings.length, 8);
  });
});
