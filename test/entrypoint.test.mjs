// Entrypoint detection: the script must run its CLI when executed directly,
// including through a symlink (how skills are installed), and must NOT run
// the CLI when imported as a module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, SCRIPT, ROOT, startServer, vercelBody } from './helpers.mjs';

test('runs CLI when executed directly', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^Usage:/);
});

test('runs CLI when executed through a symlinked skill directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-symlink-'));
  const link = join(dir, 'jev');
  symlinkSync(join(ROOT, 'skills', 'jev'), link);
  try {
    const r = await runCli(['--help'], { script: join(link, 'scripts', 'jev.mjs') });
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlinked script performs a real request end to end', async () => {
  const questions = { ok: { type: 'boolean', instructions: 'ok?' } };
  const server = await startServer(() => ({ body: vercelBody(questions) }));
  const dir = mkdtempSync(join(tmpdir(), 'jev-symlink-'));
  const link = join(dir, 'jev');
  symlinkSync(join(ROOT, 'skills', 'jev'), link);
  try {
    const r = await runCli(['--state', 'x', '--bool', 'ok=ok?'], {
      script: join(link, 'scripts', 'jev.mjs'),
      env: { JEV_API_KEY: 'k', JEV_ENDPOINT: server.url },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.ok.type, 'boolean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('importing as a module does not run the CLI or read stdin', async () => {
  // Spawn a child that imports the script and exits; if the CLI ran it would
  // either print usage/errors or block waiting on stdin.
  const code = `import(${JSON.stringify(SCRIPT)}).then(m => { console.log(JSON.stringify(Object.keys(m).sort())); })`;
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), ['JevError', 'ask', 'choose', 'evaluate', 'listProviders', 'logDir', 'logFileName', 'logLevel', 'score', 'thresholds', 'verdict']);
  assert.equal(out.stderr, '');
});
