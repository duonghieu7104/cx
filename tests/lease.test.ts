import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { gitInit, readLog, runCx, tempDir, writeFakeBinaries } from './helpers.js';

test('shared lease swaps with every baseline tag and restores in reverse', () => {
  const dir = tempDir('cx-lease-');
  gitInit(dir);
  const bin = path.join(dir, 'bin');
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'docker.log');
  const { docker, wrapper } = writeFakeBinaries(bin, stateFile, logFile);
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      services: [
        { Service: 'cdp', Image: 'local-stack/cdp-backend:d1109', State: 'running', Health: 'healthy', TagVar: 'BATCH_CDP_TAG', Kind: 'image' },
        { Service: 'fe', Image: 'local-stack/fe:dev', Mount: '/orig/app', State: 'running', Health: 'healthy', TagVar: 'BATCH_FE_APP', Kind: 'mount' },
      ],
    }),
  );
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
stack:
  mode: shared
  project: demo-local
  wrapper: ${wrapper}
  state_dir: .cx/stack
  docker_bin: ${docker}
  health_timeout: 0s
  services:
    - name: cdp
      tag_var: BATCH_CDP_TAG
      image: local-stack/cdp-backend
    - name: fe
      tag_var: BATCH_FE_APP
      image: local-stack/fe
      kind: mount
  restore:
    require_no_deps: true
    export_all_baseline_tags: true
    verify_before_release: true
    on_mismatch: keep-lease
`,
  );
  const home = tempDir('cx-lease-home-');
  const task = runCx(['task', 'new', 'demo', '--title', 'Demo'], { cwd: dir, home });
  assert.equal(task.status, 0, task.stderr);
  const leased = runCx(['stack', 'lease', 'demo'], { cwd: dir, home });
  assert.equal(leased.status, 0, leased.stderr);
  const token = /CX_LEASE_TOKEN=([0-9a-f]+)/.exec(leased.stdout)?.[1];
  assert.ok(token);
  const again = runCx(['stack', 'lease', 'demo'], { cwd: dir, home });
  assert.match(again.stdout, /already held/);
  assert.doesNotMatch(again.stdout, /CX_LEASE_TOKEN=/);
  const swapped = runCx(['stack', 'swap', 'demo', 'cdp', '--tag', 'cx-demo-abc', '--token', token], { cwd: dir, home });
  assert.equal(swapped.status, 0, swapped.stderr);
  const calls = readLog(logFile).filter((entry) => entry.wrapper);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args?.includes('--no-deps'));
  assert.equal(calls[0].batch?.BATCH_CDP_TAG, 'cx-demo-abc');
  assert.equal(calls[0].batch?.BATCH_FE_APP, '/orig/app');
  assert.ok(!readLog(logFile).some((entry) => entry.argv?.includes('exec')));
  const released = runCx(['stack', 'release', 'demo'], { cwd: dir, home });
  assert.equal(released.status, 0, released.stderr);
  const wrappers = readLog(logFile).filter((entry) => entry.wrapper);
  assert.equal(wrappers.at(-1)?.batch?.BATCH_CDP_TAG, 'd1109');
  assert.equal(fs.existsSync(path.join(dir, '.cx', 'stack', 'lease')), false);
  const cfg = loadConfig({ startDir: dir, home: '' });
  assert.equal(cfg.stack.docker_bin, docker);
});

test('a restore mismatch keeps the lease', () => {
  const dir = tempDir('cx-drift-');
  gitInit(dir);
  const bin = path.join(dir, 'bin');
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'docker.log');
  const { docker, wrapper } = writeFakeBinaries(bin, stateFile, logFile);
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      services: [
        { Service: 'cdp', Image: 'local-stack/cdp-backend:d1109', State: 'running', Health: 'healthy', TagVar: 'BATCH_CDP_TAG', Kind: 'image' },
      ],
    }),
  );
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
stack:
  mode: shared
  project: demo-local
  wrapper: ${wrapper}
  state_dir: .cx/stack
  docker_bin: ${docker}
  health_timeout: 0s
  services:
    - name: cdp
      tag_var: BATCH_CDP_TAG
      image: local-stack/cdp-backend
`,
  );
  const home = tempDir('cx-drift-home-');
  assert.equal(runCx(['task', 'new', 'demo', '--title', 'Demo'], { cwd: dir, home }).status, 0);
  const leased = runCx(['stack', 'lease', 'demo'], { cwd: dir, home });
  const token = /CX_LEASE_TOKEN=([0-9a-f]+)/.exec(leased.stdout)?.[1] ?? '';
  assert.equal(runCx(['stack', 'swap', 'demo', 'cdp', '--tag', 'cx-demo-abc', '--token', token], { cwd: dir, home }).status, 0);
  fs.writeFileSync(`${stateFile}.noop`, '1');
  const released = runCx(['stack', 'release', 'demo'], { cwd: dir, home });
  assert.notEqual(released.status, 0);
  assert.match(released.stderr, /lease kept/);
  assert.equal(fs.existsSync(path.join(dir, '.cx', 'stack', 'lease')), true);
  fs.rmSync(`${stateFile}.noop`);
  const recovered = runCx(['stack', 'recover'], { cwd: dir, home });
  assert.notEqual(recovered.status, 0);
  const lease = JSON.parse(fs.readFileSync(path.join(dir, '.cx', 'stack', 'lease', 'lease.json'), 'utf8')) as {
    pid: number;
    heartbeat: string;
  };
  lease.pid = 999999;
  lease.heartbeat = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(path.join(dir, '.cx', 'stack', 'lease', 'lease.json'), JSON.stringify(lease));
  const yes = runCx(['stack', 'recover', '--yes'], { cwd: dir, home });
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(fs.existsSync(path.join(dir, '.cx', 'stack', 'lease')), false);
});

test('per-lane up and down do not delete volumes', () => {
  const dir = tempDir('cx-lane-stack-');
  gitInit(dir);
  const bin = path.join(dir, 'bin');
  const logFile = path.join(dir, 'docker.log');
  const { docker } = writeFakeBinaries(bin, path.join(dir, 'state.json'), logFile);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ services: [] }));
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: {}\n');
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
stack:
  mode: per-lane
  compose_file: compose.yml
  project_pattern: cx-{task}
  docker_bin: ${docker}
`,
  );
  const home = tempDir('cx-lane-home-');
  assert.equal(runCx(['task', 'new', 'demo', '--title', 'Demo'], { cwd: dir, home }).status, 0);
  assert.equal(runCx(['stack', 'up', 'demo'], { cwd: dir, home }).status, 0);
  assert.equal(runCx(['stack', 'down', 'demo'], { cwd: dir, home }).status, 0);
  const commands = readLog(logFile).map((entry) => (entry.argv ?? []).join(' '));
  assert.ok(commands.some((line) => line.includes('up -d') && line.includes('cx-demo')));
  assert.ok(commands.some((line) => /\sdown$/.test(line) || line.endsWith('down')));
  assert.ok(commands.every((line) => !line.includes(' -v') && !line.includes('--volumes')));
});
