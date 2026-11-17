#!/usr/bin/env node
// Demo stand-in for the Claude CLI. It writes real files in the worktree.
// The pipeline driver is still `cx ship`. Captions call this a stub.
import fs from 'node:fs';
import path from 'node:path';

const phase = process.env.CX_PHASE || '';
const task = process.env.CX_TASK || 'task';
const output = process.env.CX_OUTPUT || '';
const worktree = process.env.CX_WORKTREE || '';

try {
  fs.readFileSync(0);
} catch {
  // stdin is optional
}

if (output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
}

if (phase === 'proposal') {
  fs.writeFileSync(output, `# Proposal\n\nAdd \`/health\` to pulse so a probe can see the process is up.\n`);
} else if (phase === 'plan') {
  fs.writeFileSync(
    output,
    `# Plan\n\n- Serve \`/health\` as a small HTML page with the word ok.\n- Add \`test/health.test.mjs\`.\n- Keep \`/\` working.\n`,
  );
} else if (phase === 'execute') {
  const appPath = path.join(worktree, 'src', 'app.mjs');
  const current = fs.readFileSync(appPath, 'utf8');
  if (!current.includes("url === '/health'")) {
    fs.writeFileSync(
      appPath,
      current.replace(
        "if (url === '/') {",
        `if (url === '/health') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>pulse health</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#102218;color:#e7ffe8;font:22px/1.4 ui-sans-serif,system-ui}h1{font-size:72px;margin:0}</style></head><body><main><h1>ok</h1><p>pulse /health</p></main></body></html>');
      return;
    }
    if (url === '/') {`,
      ),
    );
  }
  fs.mkdirSync(path.join(worktree, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, 'test', 'health.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

test('GET /health says ok', async () => {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const res = await fetch('http://127.0.0.1:' + port + '/health');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /ok/);
  server.close();
});
`,
  );
  fs.writeFileSync(output, `# Execution\n\nStub wrote /health and test/health.test.mjs in ${worktree}.\n`);
  const pause = Number(process.env.CX_STUB_SLEEP_MS || 0);
  if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
} else if (phase === 'review') {
  const body = `# Review\n\n/health is covered by test/health.test.mjs.\n\nVERDICT: GO\n`;
  fs.writeFileSync(output, body);
  process.stdout.write('VERDICT: GO\n');
} else if (output) {
  fs.writeFileSync(output, `# ${phase}\n\nStub note for ${task}.\n`);
}

if (phase !== 'review') process.stdout.write(`ok ${phase}\n`);
process.exit(0);
