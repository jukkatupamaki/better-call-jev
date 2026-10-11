#!/usr/bin/env node
// Regenerate site/llms-full.txt from README.md and skills/jev/SKILL.md, so the
// LLM-facing copy never drifts from the sources.
//
//   node tools/llms-full.mjs           write the file
//   node tools/llms-full.mjs --check   exit 1 if the file is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8').trim();

export function build({ readme, skill }) {
  const readmeBody = readme.replace(/^# /, '### ');
  const skillBody = skill.replace(/^---\n[\s\S]*?\n---\n+/, '');
  return [
    '# Better Call Jev: full reference',
    '',
    'Source: https://bettercalljev.com/ and https://github.com/jukkatupamaki/better-call-jev',
    '',
    '---',
    '',
    '## README',
    '',
    readmeBody,
    '',
    '---',
    '',
    '## SKILL.md',
    '',
    skillBody,
    '',
  ].join('\n');
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
const out = isCli ? build({ readme: read('README.md'), skill: read('skills/jev/SKILL.md') }) : null;
const target = join(ROOT, 'site', 'llms-full.txt');

if (!isCli) {
  // Imported (e.g. by tests): expose build() only.
} else if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== out) {
    console.error('site/llms-full.txt is out of date: run node tools/llms-full.mjs');
    process.exit(1);
  }
  console.log('site/llms-full.txt is up to date');
} else {
  writeFileSync(target, out);
  console.log('wrote site/llms-full.txt');
}
