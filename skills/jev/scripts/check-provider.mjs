#!/usr/bin/env node
// Conformance check for a provider entry in jev.mjs.
// Runs one request with all three question types through the given provider
// and asserts the result matches the canonical shape callers depend on.
//
//   JEV_API_KEY=... node check-provider.mjs [provider]
//
// Exit 0 on pass, 1 with a list of failures otherwise.

import { evaluate, listProviders } from './jev.mjs';

const provider = process.argv[2];
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };
const isProb = (n) => typeof n === 'number' && n >= 0 && n <= 1;

const request = {
  provider,
  state: { ticket: 'My card was charged twice for one order and I want the duplicate refunded.' },
  questions: {
    refund: { type: 'boolean', instructions: 'Is the customer asking for money back?', criteria: { true: 'asks for a refund or reversal', false: 'does not' } },
    route: { type: 'choice', instructions: 'Route this ticket.', criteria: { billing: 'charges and refunds', shipping: 'delivery', other: 'anything else' } },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] },
  },
};

let result;
try {
  result = await evaluate(request);
} catch (err) {
  console.error(`FAIL: request threw ${err.code ?? ''} ${err.message}`);
  process.exit(1);
}

check(result && typeof result === 'object', 'result is an object');
check(result.answers && typeof result.answers === 'object', 'result.answers is an object');
check(result.usage && typeof result.usage === 'object', 'result.usage is an object');
check('inputTokens' in (result.usage ?? {}), 'usage.inputTokens present (may be null)');
check('outputTokens' in (result.usage ?? {}), 'usage.outputTokens present (may be null)');
check('requestId' in result, 'requestId present (may be null)');

const a = result.answers ?? {};
check(Object.keys(a).sort().join() === 'refund,route,urgency', 'answers keyed by question names');

const b = a.refund ?? {};
check(b.type === 'boolean', 'boolean answer has type "boolean" (not a provider name like "noul")');
check(isProb(b.probability), 'boolean answer has probability in 0..1');

const c = a.route ?? {};
check(c.type === 'choice', 'choice answer has type "choice"');
check(['billing', 'shipping', 'other'].includes(c.choice), 'choice.choice is one of the declared options');
check(c.probabilities && ['billing', 'shipping', 'other'].every((k) => isProb(c.probabilities[k])), 'choice.probabilities has every option in 0..1');
check(isProb(c.confidence), 'choice.confidence in 0..1');

const s = a.urgency ?? {};
check(s.type === 'score', 'score answer has type "score"');
check(typeof s.score === 'number' && s.score >= 0 && s.score <= 2, 'score.score within 0..(rungs-1)');
check(s.probabilities && ['0', '1', '2'].every((k) => isProb(s.probabilities[k])), 'score.probabilities keyed by rung index');
check(isProb(s.confidence), 'score.confidence in 0..1');
check(!('legend' in s), 'score answer carries no provider-specific extras (e.g. legend)');

const name = provider ?? process.env.JEV_PROVIDER ?? 'vercel';
if (failures.length) {
  console.error(`FAIL: provider "${name}" (${failures.length} problem${failures.length > 1 ? 's' : ''})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: provider "${name}" conforms. Known providers: ${listProviders().join(', ')}.`);
