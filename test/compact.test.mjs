// Compact request/answer format: parser and formatter units, plus the CLI
// default (compact in, compact out) end to end.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT, runCli, startServer, vercelBody } from './helpers.mjs';

const { parseCompact, formatCompact, fmtP } = await import(join(ROOT, 'skills', 'jev', 'scripts', 'compact.mjs'));

const FULL = `@spec
Add a --dry-run flag.
@artifact
diff --git a/x b/x
@@ -1 +1 @@
?? not a question

?satisfies bool Does \`artifact\` satisfy \`spec\`?
 + every requirement is met
 - a requirement is missing
?over bool Does it do more than asked?
?kind choice What kind of change?
  bug: fixes existing behaviour
  feature: adds a capability, with commas, fine
  other
?quality score Overall quality
 unusable | major rework
 minor fixes | ready
`;

test('parses fields, all question types and escapes', () => {
  const { state, questions } = parseCompact(FULL);
  assert.deepEqual(state, {
    spec: 'Add a --dry-run flag.',
    artifact: 'diff --git a/x b/x\n@ -1 +1 @@\n? not a question',
  });
  assert.deepEqual(questions, {
    satisfies: { type: 'boolean', instructions: 'Does `artifact` satisfy `spec`?', criteria: { true: 'every requirement is met', false: 'a requirement is missing' } },
    over: { type: 'boolean', instructions: 'Does it do more than asked?' },
    kind: { type: 'choice', instructions: 'What kind of change?', criteria: { bug: 'fixes existing behaviour', feature: 'adds a capability, with commas, fine', other: 'other' } },
    quality: { type: 'score', instructions: 'Overall quality', criteria: ['unusable', 'major rework', 'minor fixes', 'ready'] },
  });
});

test('without @ fields the preamble is plain-text state', () => {
  const { state } = parseCompact('line one\n  indented\n\n?ok bool Fine?\n');
  assert.equal(state, 'line one\n  indented');
});

test('parse errors are specific', () => {
  const cases = [
    ['just text', /No questions/],
    ['?ok bool Fine?', /No state/],
    ['x\n?ok maybe Fine?', /unknown question type "maybe"/],
    ['x\n?ok', /"\?key type instructions"/],
    ['x\n?k choice Which?', /needs options/],
    ['x\n?k score How?\n only', /at least two rungs/],
    ['x\n?k bool Ok?\n + yes', /both a \+ and a -/],
    ['x\n?k bool Ok?\n yes', /start with \+/],
    ['x\n?k bool Ok?\nstray', /must be indented/],
    ['x\n?k bool A?\n?k bool B?', /given twice/],
    ['pre\n@a\nx\n?k bool A?', /Text before the first @field/],
  ];
  for (const [input, re] of cases) assert.throws(() => parseCompact(input), re, input);
});

test('fmtP is short', () => {
  assert.deepEqual([0.91, 0.9, 0.07, 1, 0, 0.999, 0.001].map(fmtP), ['.91', '.9', '.07', '1', '0', '1', '0']);
});

test('formats one line per answer, runners-up sorted, negligible ones dropped', () => {
  const out = formatCompact({
    ok: { type: 'boolean', probability: 0.91, verdict: 'yes' },
    kind: { type: 'choice', choice: 'bug', probabilities: { other: 0.08, bug: 0.72, feature: 0.2, x: 0.001 }, confidence: 0.6 },
    q: { type: 'score', score: 3, probabilities: { 0: 0.01, 1: 0.03, 2: 0.15, 3: 0.81 }, confidence: 0.7 },
    sure: { type: 'choice', choice: 'a', probabilities: { a: 1, b: 0 }, confidence: 1 },
  });
  assert.equal(out, [
    'ok yes .91',
    'kind bug .72 c=.6 | feature .2 other .08',
    'q 3/3 .81 c=.7 | 2:.15 1:.03 0:.01',
    'sure a 1 c=1',
  ].join('\n'));
});

let server;
let env;
before(async () => {
  server = await startServer((body) => ({ body: vercelBody(body.questions) }));
  env = { JEV_API_KEY: 'k', JEV_ENDPOINT: server.url };
});
after(() => server.close());

test('CLI: compact request on stdin, compact answers on stdout', async () => {
  const r = await runCli([], { env, stdin: FULL });
  assert.equal(r.code, 0, r.stderr);
  const body = server.requests.at(-1).body;
  assert.equal(body.state.spec, 'Add a --dry-run flag.');
  assert.deepEqual(Object.keys(body.questions), ['satisfies', 'over', 'kind', 'quality']);
  assert.equal(r.stdout, 'satisfies yes .9\nover yes .9\nkind bug 1 c=1\nquality 1/3 1 c=1\n');
});

test('CLI: --verbose adds a usage line; --json keeps the JSON form', async () => {
  let r = await runCli(['--verbose'], { env, stdin: 'x\n?ok bool Fine?' });
  assert.equal(r.stdout, 'ok yes .9\n# in=100 out=10 id=gen_test\n');
  r = await runCli(['--json'], { env, stdin: 'x\n?ok bool Fine?' });
  assert.equal(r.json.ok.verdict, 'yes');
});

test('CLI: JSON request on stdin still works', async () => {
  const r = await runCli([], { env, stdin: ' {"state":"x","questions":{"ok":{"type":"boolean","instructions":"f?"}}}' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'ok yes .9\n');
});

test('CLI: compact parse error exits 1 without a request', async () => {
  const n = server.requests.length;
  const r = await runCli([], { env, stdin: 'x\n?ok nope Fine?' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown question type/);
  assert.equal(server.requests.length, n);
});
