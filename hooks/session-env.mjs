#!/usr/bin/env node
// SessionStart hook: export the Claude Code session id as JEV_SESSION_ID so every
// Jev call in the session is tagged with it in the local call log.
//
// Claude Code passes the hook input as JSON on stdin and sources $CLAUDE_ENV_FILE
// before each Bash command. Prints nothing (SessionStart stdout becomes context)
// and always exits 0: a missing id or env file just means calls log session null.

import { appendFileSync } from 'node:fs';

function exportLine(sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,200}$/.test(sessionId)) return null;
  return `export JEV_SESSION_ID='${sessionId}'\n`;
}

async function main() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const line = exportLine(input.session_id);
  if (line) appendFileSync(envFile, line);
}

main().catch(() => {}).finally(() => process.exit(0));
