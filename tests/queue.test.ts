import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { withQueue } from '../src/queue.js';
import { cliPath, gitInit, runCx, tempDir } from './helpers.js';

test('serial queue waits out the cooldown', () => {
  const dir = tempDir('cx-cool-');
  fs.writeFileSync(
    path.join(dir, 'cx.config.yaml'),
    `version: 1
workspace:
  mode: single-repo
  repos:
    - id: app
      path: .
      base: main
phases:
  - id: intake
    actor: cli
queue:
  mode: serial
  parallelism: 1
  cooldown: 250ms
`,
  );
  const cfg = loadConfig({ startDir: dir, home: '' });
  const stamps: number[] = [];
  withQueue(cfg, 'a', 'one', () => {
    stamps.push(Date.now());
  });
  withQueue(cfg, 'a', 'two', () => {
    stamps.push(Date.now());
  });
  assert.ok(stamps[1] - stamps[0] >= 200, `cooldown gap was ${stamps[1] - stamps[0]}ms`);
});

test('two check processes do not overlap', async () => {
  const dir = tempDir('cx-serial-');
  gitInit(dir);
  const log = path.join(dir, 'check.log');
  fs.writeFileSync(
    path.join(dir, 'check.mjs'),
    `import fs from 'node:fs';
fs.appendFileSync(process.env.CX_LOG, 'A');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
fs.appendFileSync(process.env.CX_LOG, 'B');
`,
  );
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['add', 'check.mjs']);
  git(['commit', '-m', 'check script']);
  fs.writeFileSync(
    path.join(dir, 'cx.config.yaml'),
    `version: 1
workspace:
  mode: single-repo
  repos:
    - id: app
      path: .
      base: main
      check: node check.mjs
phases:
  - id: intake
    actor: cli
queue:
  mode: serial
  parallelism: 1
  cooldown: 0s
`,
  );
  const created = runCx(['task', 'new', 'demo', '--title', 'Demo'], { cwd: dir });
  assert.equal(created.status, 0, created.stderr);
  const env = {
    ...process.env,
    HOME: created.home,
    CX_LOG: log,
    GIT_CONFIG_GLOBAL: path.join(created.home, '.gitconfig'),
  };
  const start = () => spawn(process.execPath, [cliPath, 'check', 'demo'], { cwd: dir, env });
  const left = start();
  const right = start();
  const [leftCode, rightCode] = await Promise.all([exitCode(left), exitCode(right)]);
  assert.equal(leftCode, 0);
  assert.equal(rightCode, 0);
  assert.equal(fs.readFileSync(log, 'utf8'), 'ABAB');
});

function exitCode(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(0);
    });
  });
}
