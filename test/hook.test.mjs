// SessionStart hook that exports JEV_SESSION_ID through $CLAUDE_ENV_FILE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, SCRIPT, startServer, vercelBody } from './helpers.mjs';

const HOOK = join(ROOT, 'hooks', 'session-env.mjs');
const freshDir = () => mkdtempSync(join(tmpdir(), 'jev-hook-'));

function runHook(stdin, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('writes an export line for the session id and prints nothing', async () => {
  const envFile = join(freshDir(), 'env');
  writeFileSync(envFile, 'export OTHER=1\n');
  const r = await runHook(JSON.stringify({ session_id: 'abc-123', hook_event_name: 'SessionStart' }), { CLAUDE_ENV_FILE: envFile });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(readFileSync(envFile, 'utf8'), "export OTHER=1\nexport JEV_SESSION_ID='abc-123'\n");
});

test('no env file: exits 0 and does nothing', async () => {
  const r = await runHook(JSON.stringify({ session_id: 'abc' }), {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

for (const [name, stdin] of [
  ['missing id', '{}'],
  ['empty stdin', ''],
  ['bad json', 'not json'],
  ['shell metacharacters', JSON.stringify({ session_id: "x'; rm -rf / #" })],
  ['non-string id', JSON.stringify({ session_id: 42 })],
]) {
  test(`${name}: exits 0 and writes nothing`, async () => {
    const envFile = join(freshDir(), 'env');
    const r = await runHook(stdin, { CLAUDE_ENV_FILE: envFile });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(envFile), false);
  });
}

test('hooks.json registers the hook on SessionStart', () => {
  const h = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const cmds = h.hooks.SessionStart.flatMap((e) => e.hooks.map((x) => x.command));
  assert.ok(cmds.some((c) => c.includes('hooks/session-env.mjs')));
});

test('end to end: sourced env file tags the logged call', { skip: process.platform === 'win32' }, async () => {
  const dir = freshDir();
  const envFile = join(dir, 'env');
  const logDir = join(dir, 'log');
  await runHook(JSON.stringify({ session_id: 'sess-e2e' }), { CLAUDE_ENV_FILE: envFile });
  const server = await startServer((body) => ({ body: vercelBody(body.questions) }));
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', `. "${envFile}"; exec "${process.execPath}" "${SCRIPT}" --state x --bool ok=ok?`], {
        env: { PATH: process.env.PATH, JEV_API_KEY: 'k', JEV_ENDPOINT: server.url, JEV_LOG_DIR: logDir },
        stdio: 'ignore',
      });
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
  } finally {
    await server.close();
  }
  const [file] = readdirSync(logDir);
  const rec = JSON.parse(readFileSync(join(logDir, file), 'utf8').trim());
  assert.equal(rec.session, 'sess-e2e');
});
