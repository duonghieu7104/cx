#!/usr/bin/env node
// Drives a real sample repo through cx and screenshots the dashboard.
// The coding agent is scripts/demo-stub.mjs. Checks are the sample's real tests.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from '/tmp/pw/node_modules/playwright-core/index.js';

const { chromium } = playwright;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist', 'src', 'cli.js');
const shots = path.join(repoRoot, 'docs', 'screenshots');
const home = '/tmp/cx-demo-home';
const pulse = '/tmp/cx-demo-pulse';
const stackWs = '/tmp/cx-demo-stack';
fs.mkdirSync(shots, { recursive: true });
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, '.gitconfig'),
  '[user]\n\temail = cx-demo@example.com\n\tname = cx demo\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[safe]\n\tdirectory = *\n',
);

const envBase = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  CX_CLAUDE_BIN: path.join(repoRoot, 'scripts', 'demo-stub.mjs'),
};

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...envBase, ...opts.env },
    encoding: 'utf8',
  });
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function cx(args, cwd, extra = {}) {
  return run(process.execPath, [cli, ...args], { cwd, env: extra });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function snap(port, token) {
  const opened = await fetch(`http://127.0.0.1:${port}/?t=${token}`, { redirect: 'manual' });
  const cookie = opened.headers.get('set-cookie')?.split(';')[0] ?? '';
  const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { headers: { cookie } });
  return res.json();
}

function startDash(cwd, port, extra = {}) {
  const child = spawn(process.execPath, [cli, 'dash', '--port', String(port)], {
    cwd,
    env: { ...envBase, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dash did not start\n${out}`)), 8000);
    child.stdout.on('data', (buf) => {
      out += buf.toString();
      const match = /t=([0-9a-f]+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ child, token: match[1], port, log: out });
      }
    });
    child.on('exit', (code) => reject(new Error(`dash exited ${code}\n${out}`)));
  });
}

async function browserFor(port, token) {
  const browser = await chromium.launch({
    executablePath: '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/?t=${token}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('h1');
  return { browser, page };
}

async function shoot(page, file, hash) {
  if (hash) {
    await page.evaluate((next) => {
      location.hash = next;
    }, hash);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(shots, file), fullPage: true });
  console.log('shot', file);
}

function writePulse() {
  fs.rmSync(pulse, { recursive: true, force: true });
  fs.mkdirSync(path.join(pulse, 'src'), { recursive: true });
  fs.mkdirSync(path.join(pulse, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(pulse, 'package.json'),
    JSON.stringify({ name: 'pulse', private: true, type: 'module', scripts: { test: 'node --test', start: 'node src/server.mjs' } }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(pulse, 'src', 'app.mjs'),
    `import http from 'node:http';

export function createApp() {
  return http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>pulse</title><h1>pulse</h1>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}
`,
  );
  fs.writeFileSync(
    path.join(pulse, 'src', 'server.mjs'),
    `import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 4173);
createApp().listen(port, '127.0.0.1', () => {
  console.log('listening ' + port);
});
`,
  );
  fs.writeFileSync(
    path.join(pulse, 'test', 'home.test.mjs'),
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

test('GET / mentions pulse', async () => {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const res = await fetch('http://127.0.0.1:' + port + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /pulse/);
  server.close();
});
`,
  );
  const git = (args) => run('git', args, { cwd: pulse });
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['commit', '-m', 'pulse home page']);
}

async function waitUntil(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  writePulse();
  cx(['init', '--preset', 'single-repo'], pulse);
  const configPath = path.join(pulse, 'cx.config.yaml');
  fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('enabled: false', 'enabled: true'));
  const dash = await startDash(pulse, 8377);
  const session = await browserFor(dash.port, dash.token);
  await shoot(session.page, '01-empty-board.png', '#/');

  cx(['task', 'new', 'healthz', '--title', 'Add a /health endpoint with a test', '--type', 'feat'], pulse);
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '02-task-created.png', '#/');
  await shoot(session.page, '03-lane-worktree.png', '#/task/healthz');

  const worktree = path.join(pulse, '.worktrees', 'healthz-app');
  const branch = run('git', ['-C', worktree, 'branch', '--show-current']).stdout.trim();
  const listed = run('git', ['-C', pulse, 'worktree', 'list']).stdout;
  fs.writeFileSync(
    path.join(shots, 'terminal-worktree.txt'),
    `$ git -C ${worktree} branch --show-current\n${branch}\n\n$ git -C ${pulse} worktree list\n${listed}\n`,
  );

  fs.chmodSync(path.join(repoRoot, 'scripts', 'demo-stub.mjs'), 0o755);
  const shipping = spawn(process.execPath, [cli, 'ship', 'healthz', '--auto-plan', '--until', 'checks'], {
    cwd: pulse,
    env: { ...envBase, CX_STUB_SLEEP_MS: '8000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let shipLog = '';
  shipping.stdout.on('data', (buf) => {
    shipLog += buf.toString();
  });
  shipping.stderr.on('data', (buf) => {
    shipLog += buf.toString();
  });
  await waitUntil(() => fs.existsSync(path.join(worktree, 'test', 'health.test.mjs')), 'health test file');
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '04-implement.png', '#/task/healthz');
  const shipCode = await new Promise((resolve) => shipping.on('exit', resolve));
  if (shipCode !== 0) throw new Error(`ship --until checks failed\n${shipLog}`);

  const checked = cx(['check', 'healthz'], pulse);
  fs.writeFileSync(path.join(shots, 'terminal-checks.txt'), `$ cx check healthz\n${checked.stdout}\n${checked.stderr}\n`);
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '05-checks-passed.png', '#/task/healthz');

  cx(['ship', 'healthz', '--auto-plan', '--until', 'test_local'], pulse);
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '06-review-go.png', '#/task/healthz');

  const server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: worktree,
    env: { ...envBase, PORT: '4173' },
    stdio: 'ignore',
  });
  await waitUntil(async () => {
    try {
      const res = await fetch('http://127.0.0.1:4173/health');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'sample /health');
  const proofDir = path.join(pulse, 'docs', 'tasks', 'healthz', '5-test', 'shots');
  fs.mkdirSync(proofDir, { recursive: true });
  const proofPage = await session.browser.newPage({ viewport: { width: 1440, height: 900 } });
  await proofPage.goto('http://127.0.0.1:4173/health', { waitUntil: 'networkidle' });
  await proofPage.screenshot({ path: path.join(proofDir, 'health.png') });
  await proofPage.close();
  server.kill('SIGTERM');

  await session.page.reload({ waitUntil: 'networkidle' });
  await session.page.evaluate(() => {
    location.hash = '#/task/healthz';
  });
  await session.page.waitForSelector('[data-proof]');
  await session.page.click('[data-proof]');
  await session.page.waitForSelector('.lightbox img');
  await session.page.screenshot({ path: path.join(shots, '07-qc-proof.png'), fullPage: true });
  console.log('shot 07-qc-proof.png');

  cx(['ship', 'healthz', '--auto-plan'], pulse);
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '08-human-gate.png', '#/');

  cx(['approve', 'healthz', 'commit', '--note', 'health page looks right'], pulse);
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '09-approved.png', '#/task/healthz');

  cx(['task', 'new', 'readme-pass', '--title', 'Add a readiness note', '--type', 'feat'], pulse);
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '10-two-tasks.png', '#/');

  const listedAfter = run('git', ['-C', pulse, 'worktree', 'list']).stdout;
  const branches = run('git', ['-C', pulse, 'branch']).stdout;
  fs.appendFileSync(
    path.join(shots, 'terminal-worktree.txt'),
    `\n$ git -C ${pulse} branch\n${branches}\n$ git worktree list\n${listedAfter}\n`,
  );

  await session.browser.close();
  dash.child.kill('SIGTERM');

  await stackDemo();
}

async function stackDemo() {
  fs.rmSync(stackWs, { recursive: true, force: true });
  fs.mkdirSync(stackWs, { recursive: true });
  for (const [name, branch] of [
    ['FRONTEND_CLUEGA_HOME', 'dev'],
    ['BACKEND_CLUEGA_CDP', 'dev'],
  ]) {
    const dir = path.join(stackWs, name);
    fs.mkdirSync(dir, { recursive: true });
    run('git', ['init', '-b', branch], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    run('git', ['add', 'README.md'], { cwd: dir });
    run('git', ['commit', '-m', 'init'], { cwd: dir });
  }
  const stateFile = path.join(stackWs, 'fake-state.json');
  const logFile = path.join(stackWs, 'fake.log');
  const bin = path.join(stackWs, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(stackWs, '.local-stack'), { recursive: true });
  const dockerJs = path.join(bin, 'docker.mjs');
  const wrapperJs = path.join(bin, 'wrapper.mjs');
  fs.writeFileSync(dockerJs, fakeDocker(stateFile, logFile));
  fs.writeFileSync(wrapperJs, fakeWrapper(stateFile, logFile));
  const docker = path.join(bin, 'docker');
  const wrapper = path.join(stackWs, '.local-stack', 'batchlaunch-dc.sh');
  fs.writeFileSync(docker, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(dockerJs)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapperJs)} "$@"\n`, { mode: 0o755 });
  const hold = path.join(stackWs, 'hold.mjs');
  fs.writeFileSync(hold, `await new Promise((resolve) => setTimeout(resolve, 20000));\n`);
  cx(['init', '--preset', 'cluega'], stackWs);
  const configPath = path.join(stackWs, 'cx.config.yaml');
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, 'utf8').replace(
      'check: make test && make lint',
      `check: node ${hold}`,
    ),
  );
  const printed = JSON.parse(cx(['config', 'print', '--json'], stackWs).stdout);
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      services: printed.stack.services.map((service) => ({
        Service: service.name,
        Image: `${service.image}:base`,
        Mount: service.kind === 'mount' ? '/orig/app' : '',
        State: 'running',
        Health: 'healthy',
        TagVar: service.tag_var,
        Kind: service.kind || 'image',
      })),
    }),
  );
  cx(
    ['task', 'new', 'streamfix', '--title', 'Swap cdp for a local tag', '--repos', 'FE,cdp', '--type', 'fix', '--desc', 'stream-chat'],
    stackWs,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  const dash = await startDash(stackWs, 8391, { PATH: `${bin}:${process.env.PATH}` });
  const session = await browserFor(dash.port, dash.token);
  const leased = cx(['stack', 'lease', 'streamfix'], stackWs, { PATH: `${bin}:${process.env.PATH}` });
  const token = /CX_LEASE_TOKEN=([0-9a-f]+)/.exec(leased.stdout)?.[1];
  cx(['stack', 'swap', 'streamfix', 'cdp', '--tag', 'cx-streamfix-demo', '--token', token], stackWs, {
    PATH: `${bin}:${process.env.PATH}`,
  });
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '11-stack-lease.png', '#/stack');
  fs.writeFileSync(
    path.join(shots, 'terminal-stack.txt'),
    `$ cx stack lease streamfix\n${leased.stdout}\n$ cx stack swap streamfix cdp --tag cx-streamfix-demo\n`,
  );

  const checking = spawn(process.execPath, [cli, 'check', 'streamfix', 'cdp'], {
    cwd: stackWs,
    env: { ...envBase, PATH: `${bin}:${process.env.PATH}` },
    stdio: 'ignore',
  });
  await waitUntil(async () => {
    const body = await snap(dash.port, dash.token);
    return (body.queue.running || []).some((item) => item.task === 'streamfix');
  }, 'queue running');
  await session.page.reload({ waitUntil: 'networkidle' });
  await shoot(session.page, '12-build-queue.png', '#/queue');
  checking.kill('SIGTERM');
  await session.browser.close();
  dash.child.kill('SIGTERM');
}

function fakeDocker(stateFile, logFile) {
  return `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: args }) + '\\n');
if (args[0] === 'compose' && args.includes('ps')) {
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  process.stdout.write(state.services.map((row) => JSON.stringify(row)).join('\\n') + '\\n');
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
process.exit(0);
`;
}

function fakeWrapper(stateFile, logFile) {
  return `import fs from 'node:fs';
const args = process.argv.slice(2);
const batch = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('BATCH_') || key.startsWith('REPLACE_ME_')) batch[key] = value;
}
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ wrapper: true, args, batch }) + '\\n');
if (!args.includes('--no-deps')) process.exit(2);
const service = args[args.length - 1];
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const item = state.services.find((row) => row.Service === service);
if (item && process.env[item.TagVar]) {
  if (item.Kind === 'mount') item.Mount = process.env[item.TagVar];
  else item.Image = String(item.Image).split(':')[0] + ':' + process.env[item.TagVar];
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
}
process.exit(0);
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
