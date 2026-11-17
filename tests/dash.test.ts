import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { startDashboard } from '../src/dash.js';
import { gitInit, tempDir } from './helpers.js';

test('dashboard is local, authenticated, and read-only', async () => {
  const dir = tempDir('cx-dash-');
  const home = tempDir('cx-dash-home-');
  gitInit(dir);
  fs.writeFileSync(
    path.join(dir, 'cx.config.yaml'),
    `version: 1
workspace:
  mode: single-repo
  root: .
  repos:
    - id: app
      path: .
      base: main
      check: "true"
phases:
  - id: intake
    actor: cli
  - id: gate
    actor: human
    gate: commit
`,
  );
  fs.writeFileSync(path.join(dir, '.env'), 'canary-env-value-9f3a\n', { mode: 0o644 });
  const handle = await startDashboard({ port: 0, cwd: dir, home });
  try {
  assert.equal(handle.address, '127.0.0.1');
  const tokenStat = fs.statSync(path.join(home, '.config', 'cx', 'dash.token'));
  assert.equal(tokenStat.mode & 0o777, 0o600);

  const bare = await ask(handle.port, '/api/snapshot');
  assert.equal(bare.status, 401);

  const evil = await ask(handle.port, '/api/snapshot', { host: 'evil.example' });
  assert.equal(evil.status, 403);

  const wrong = await ask(handle.port, `/?t=not-the-token`);
  assert.equal(wrong.status, 401);

  const opened = await ask(handle.port, `/?t=${handle.token}`);
  assert.equal(opened.status, 302);
  const setCookie = headerValue(opened.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.equal(String(opened.body).includes(handle.token), false);
  const cookie = setCookie.split(';')[0];

  const snap = await ask(handle.port, '/api/snapshot', { cookie });
  assert.equal(snap.status, 200);
  const body = JSON.parse(snap.body);
  assert.equal(body.read_only, true);
  assert.equal(JSON.stringify(body).includes(handle.token), false);
  assert.equal(JSON.stringify(body).includes('canary-env-value-9f3a'), false);

  const posted = await ask(handle.port, '/api/snapshot', { cookie, method: 'POST' });
  assert.equal(posted.status, 405);

  const creds = await ask(handle.port, '/api/lane/1/creds-current', { cookie });
  assert.equal(creds.status, 404);
  const envFile = await ask(handle.port, '/.env', { cookie });
  assert.equal(envFile.status, 404);

  const escaped = await ask(handle.port, '/proof/demo/../../.env', { cookie });
  assert.equal(escaped.status, 404);
  } finally {
    await handle.close();
  }
});

test('snapshot redacts event secrets and serves only proof images', async () => {
  const dir = tempDir('cx-dash-proof-');
  const home = tempDir('cx-dash-proof-home-');
  gitInit(dir);
  fs.writeFileSync(
    path.join(dir, 'cx.config.yaml'),
    `version: 1
workspace:
  mode: single-repo
  root: .
  repos:
    - id: app
      path: .
      base: main
phases:
  - id: intake
    actor: cli
tasks:
  root: docs/tasks
  folders:
    test_local: 5-test
`,
  );
  fs.mkdirSync(path.join(dir, 'docs', 'tasks', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'docs', 'tasks', 'demo', 'README.md'),
    `# Demo\n\n**Status (01/01/2026):** intake — created\n\n<!-- cx:state:begin -->\n\`\`\`yaml\ntask: demo\ntitle: Demo\nphase: intake\nupdated: 2026-01-01T00:00:00.000Z\nsummary: created\nlanes: []\nreview: { round: 0, verdict: null }\napprovals: []\nprs: []\n\`\`\`\n<!-- cx:state:end -->\n`,
  );
  const logDir = path.join(dir, 'docs', 'tasks', 'demo');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'events.ndjson'), `${JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', actor: 'cx', event: 'note', data: { leak: 'NPM_TOKEN=supersecret' } })}\n`);
  const shot = path.join(dir, 'docs', 'tasks', 'demo', '5-test');
  fs.mkdirSync(shot, { recursive: true });
  fs.writeFileSync(path.join(shot, 'health.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(shot, 'notes.txt'), 'not-an-image');

  const handle = await startDashboard({ port: 0, cwd: dir, home });
  try {
  const opened = await ask(handle.port, `/?t=${handle.token}`);
  const cookie = headerValue(opened.headers['set-cookie']).split(';')[0];
  const snap = await ask(handle.port, '/api/snapshot', { cookie });
  assert.equal(snap.status, 200, snap.body);
  assert.equal(snap.body.includes('supersecret'), false);
  assert.match(snap.body, /\[redacted\]/);
  const proof = await ask(handle.port, '/proof/demo/health.png', { cookie });
  assert.equal(proof.status, 200);
  assert.match(proof.headers['content-type'] ?? '', /image\/png/);
  const text = await ask(handle.port, '/proof/demo/notes.txt', { cookie });
  assert.equal(text.status, 404);
  } finally {
    await handle.close();
  }
});

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join('; ');
  return value ?? '';
}

function ask(
  port: number,
  pathname: string,
  opts: { host?: string; cookie?: string; method?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method ?? 'GET',
        headers: {
          host: opts.host ? opts.host : `127.0.0.1:${port}`,
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
