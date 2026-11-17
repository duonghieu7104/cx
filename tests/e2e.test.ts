import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { readState } from '../src/state.js';
import { cliPath, gitInit, readLog, repoRoot, runCx, tempDir, writeFakeBinaries } from './helpers.js';

test('stubbed /ship-task reaches the human gate on a single repo', () => {
  const dir = tempDir('cx-e2e-');
  gitInit(dir);
  const home = tempDir('cx-e2e-home-');
  assert.equal(runCx(['init', '--preset', 'single-repo'], { cwd: dir, home }).status, 0);
  assert.equal(runCx(['config', 'validate'], { cwd: dir, home }).status, 0);
  const created = runCx(['task', 'new', 'demo', '--title', 'Demo feature', '--type', 'feat'], { cwd: dir, home });
  assert.equal(created.status, 0, created.stderr);
  const stub = path.join(dir, 'stub-claude');
  fs.copyFileSync(path.join(repoRoot, 'tests', 'fixtures', 'stub-claude.mjs'), stub);
  fs.chmodSync(stub, 0o755);
  const shipped = spawnSync(process.execPath, [stub, '/ship-task', 'demo'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      CX_BIN: cliPath,
      CX_CLAUDE_BIN: stub,
    },
  });
  assert.equal(shipped.status, 0, `${shipped.stdout}\n${shipped.stderr}`);
  const cfg = loadConfig({ startDir: dir, home: '' });
  const state = readState(cfg, 'demo');
  assert.equal(state.phase, 'gate');
  assert.equal(state.review.verdict, 'GO');
  const task = path.join(dir, 'docs', 'tasks', 'demo');
  assert.ok(fs.existsSync(path.join(task, '1-proposal', 'PROPOSAL.md')));
  assert.ok(fs.existsSync(path.join(task, '2-plan', 'PLAN.md')));
  assert.ok(fs.existsSync(path.join(task, '4-execute', 'EXECUTION.md')));
  assert.ok(fs.existsSync(path.join(task, '4-execute', 'REVIEW-1.md')));
  assert.match(`${shipped.stdout}`, /cx approve demo commit/);
  assert.match(fs.readFileSync(path.join(task, '4-execute', 'REVIEW-1.md'), 'utf8'), /VERDICT: GO/);
});

test('doctor reports env file mode without reading it', () => {
  const dir = tempDir('cx-doctor-');
  gitInit(dir);
  const home = tempDir('cx-doctor-home-');
  runCx(['init', '--preset', 'single-repo'], { cwd: dir, home });
  fs.writeFileSync(path.join(dir, '.env'), 'canary-env-value-9f3a\n', { mode: 0o644 });
  const result = runCx(['doctor'], { cwd: dir, home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /env mode/);
  assert.match(result.stdout, /644/);
  assert.equal(`${result.stdout}${result.stderr}`.includes('canary-env-value-9f3a'), false);
});

test('inspect and from-inspect produce a valid config', () => {
  const dir = tempDir('cx-inspect-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'compose.yml'), 'services: {}\n');
  const home = tempDir('cx-inspect-home-');
  const inspected = runCx(['inspect'], { cwd: dir, home });
  assert.equal(inspected.status, 0, inspected.stderr);
  const report = JSON.parse(inspected.stdout) as { packageManager: string; suggested: { check: string }; questions: string[] };
  assert.equal(report.packageManager, 'npm');
  assert.equal(report.suggested.check, 'npm test');
  assert.ok(report.questions.some((question) => /stack/i.test(question)));
  assert.equal(runCx(['init', '--from-inspect'], { cwd: dir, home }).status, 0);
  assert.equal(runCx(['config', 'validate'], { cwd: dir, home }).status, 0);
});

test('cluega preset drives a fake multi-repo shared stack', () => {
  const dir = tempDir('cx-cluega-');
  gitInit(path.join(dir, 'FRONTEND_CLUEGA_HOME'), 'dev');
  gitInit(path.join(dir, 'BACKEND_CLUEGA_CDP'), 'dev');
  const stateFile = path.join(dir, 'fake-state.json');
  const logFile = path.join(dir, 'fake.log');
  const bin = path.join(dir, 'bin');
  const { docker, wrapper } = writeFakeBinaries(bin, stateFile, logFile);
  fs.mkdirSync(path.join(dir, '.local-stack'), { recursive: true });
  fs.copyFileSync(wrapper, path.join(dir, '.local-stack', 'batchlaunch-dc.sh'));
  fs.chmodSync(path.join(dir, '.local-stack', 'batchlaunch-dc.sh'), 0o755);
  fs.writeFileSync(path.join(dir, '.local-stack', '.env'), 'canary-env-value-9f3a\n', { mode: 0o644 });
  const home = tempDir('cx-cluega-home-');
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  assert.equal(runCx(['init', '--preset', 'cluega'], { cwd: dir, home, env }).status, 0);
  const validated = runCx(['config', 'validate'], { cwd: dir, home, env });
  assert.equal(validated.status, 0, validated.stderr);
  const cfg = loadConfig({ startDir: dir, home: '' });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      services: cfg.stack.services.map((service) => ({
        Service: service.name,
        Image: `${service.image}:base`,
        Mount: service.kind === 'mount' ? '/orig/app' : '',
        State: 'running',
        Health: 'healthy',
        TagVar: service.tag_var,
        Kind: service.kind,
      })),
    }),
  );
  const created = runCx(
    ['task', 'new', 'streamfix', '--title', 'Sua stream chat', '--repos', 'FE,cdp', '--type', 'fix', '--desc', 'stream-chat-reconnect'],
    { cwd: dir, home, env },
  );
  assert.equal(created.status, 0, created.stderr);
  const state = readState(cfg, 'streamfix');
  const fe = state.lanes.find((lane) => lane.repo === 'FRONTEND_CLUEGA_HOME');
  const cdp = state.lanes.find((lane) => lane.repo === 'BACKEND_CLUEGA_CDP');
  assert.ok(fe && cdp);
  assert.equal(fe?.branch, 'fix/stream-chat-reconnect');
  assert.equal(fe?.base, 'dev');
  assert.ok(fs.existsSync(path.resolve(dir, fe?.worktree ?? '')));
  assert.ok(fs.existsSync(path.join(dir, 'plans', 'streamfix', 'README.md')));
  const branch = spawnSync('git', ['branch', '--show-current'], {
    cwd: path.resolve(dir, fe?.worktree ?? ''),
    encoding: 'utf8',
  });
  assert.equal(branch.stdout.trim(), 'fix/stream-chat-reconnect');
  const leased = runCx(['stack', 'lease', 'streamfix'], { cwd: dir, home, env });
  assert.equal(leased.status, 0, leased.stderr);
  const token = /CX_LEASE_TOKEN=([0-9a-f]+)/.exec(leased.stdout)?.[1] ?? '';
  const swapped = runCx(['stack', 'swap', 'streamfix', 'cdp', '--tag', 'cx-streamfix-abc', '--token', token], {
    cwd: dir,
    home,
    env,
  });
  assert.equal(swapped.status, 0, swapped.stderr);
  const call = readLog(logFile).find((entry) => entry.wrapper);
  assert.ok(call?.args?.includes('--no-deps'));
  assert.equal(call?.args?.at(-1), 'cdp');
  for (const service of cfg.stack.services) {
    assert.ok(call?.batch?.[service.tag_var], `missing ${service.tag_var}`);
  }
  assert.equal(call?.batch?.BATCH_CDP_TAG, 'cx-streamfix-abc');
  assert.equal(call?.batch?.BATCH_FE_APP, '/orig/app');
  assert.ok(readLog(logFile).some((entry) => entry.argv?.includes('cluega-local')));
  assert.ok(readLog(logFile).every((entry) => !(entry.argv ?? []).includes('exec')));
  const released = runCx(['stack', 'release', 'streamfix'], { cwd: dir, home, env });
  assert.equal(released.status, 0, released.stderr);
  const restores = readLog(logFile).filter((entry) => entry.wrapper);
  assert.equal(restores.at(-1)?.batch?.BATCH_CDP_TAG, 'base');
  assert.equal(fs.existsSync(path.join(dir, '.local-stack', '.cx', 'lease')), false);
  const doctor = runCx(['doctor'], { cwd: dir, home, env });
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /644/);
  assert.equal(`${doctor.stdout}${doctor.stderr}`.includes('canary-env-value-9f3a'), false);
});
