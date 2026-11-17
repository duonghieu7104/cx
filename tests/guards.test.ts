import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { readState } from '../src/state.js';
import { gitInit, repoRoot, runCx, tempDir } from './helpers.js';
import { redact } from '../src/redact.js';

const bashHook = path.join(repoRoot, 'claude', 'hooks', 'bash-guard.mjs');
const editHook = path.join(repoRoot, 'claude', 'hooks', 'edit-guard.mjs');
const mcpHook = path.join(repoRoot, 'claude', 'hooks', 'mcp-guard.mjs');
const leaseHook = path.join(repoRoot, 'claude', 'hooks', 'lease-safety.mjs');

test('hooks enforce project config with an empty environment', () => {
  const dir = tempDir('cx-hook-');
  const loose = tempDir('cx-loose-');
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
guards:
  blocked_commands:
    - pattern: '(^|[;&|]|\\n)\\s*git\\s+push\\b'
      reason: no push from the project
  protected_files:
    - "**/.env"
  mcp_deny:
    - "*budget*"
  secret_assignments:
    - 'NPM_TOKEN\\s*='
  protect_primary_checkout: false
`,
  );
  fs.writeFileSync(
    path.join(loose, 'cx.config.yaml'),
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
guards:
  blocked_commands: []
`,
  );
  const denied = hook(
    bashHook,
    dir,
    { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, cwd: dir },
    [`CX_CONFIG=${path.join(loose, 'cx.config.yaml')}`],
  );
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /no push from the project/);
  const approve = hook(bashHook, dir, { tool_name: 'Bash', tool_input: { command: 'cx approve demo commit' }, cwd: dir });
  assert.equal(approve.status, 2);
  assert.match(approve.stderr, /human/);
  const allowed = hook(bashHook, dir, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: dir });
  assert.equal(allowed.status, 0, allowed.stderr);
  const edit = hook(editHook, dir, {
    tool_name: 'Write',
    cwd: dir,
    tool_input: { file_path: path.join(dir, '.env'), content: 'x' },
  });
  assert.equal(edit.status, 2);
  const secret = hook(editHook, dir, {
    tool_name: 'Write',
    cwd: dir,
    tool_input: { file_path: path.join(dir, 'notes.txt'), content: 'NPM_TOKEN=abcdef' },
  });
  assert.equal(secret.status, 2);
  const mcp = hook(mcpHook, dir, {
    tool_name: 'mcp__ads__update_budget',
    cwd: dir,
    tool_input: { amount: 10 },
  });
  assert.equal(mcp.status, 2);
  assert.match(mcp.stderr, /budget/);
});

test('session end releases a lease without inherited config env', () => {
  const dir = tempDir('cx-lease-hook-');
  gitInit(dir);
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'docker.log');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const docker = path.join(dir, 'bin', 'docker');
  const wrapper = path.join(dir, 'wrapper');
  fs.writeFileSync(stateFile, JSON.stringify({ services: [] }));
  const dockerJs = path.join(dir, 'bin', 'docker.mjs');
  fs.writeFileSync(
    dockerJs,
    `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
if (process.argv.includes('ps')) process.stdout.write('\\n');
process.exit(0);
`,
  );
  fs.writeFileSync(docker, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(dockerJs)} "$@"\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
  project: demo
  wrapper: ${wrapper}
  docker_bin: ${docker}
  state_dir: .cx/stack
  health_timeout: 0s
  services:
    - name: app
      tag_var: BATCH_APP_TAG
      image: local/app
`,
  );
  const home = tempDir('cx-lease-hook-home-');
  assert.equal(runCx(['task', 'new', 'demo', '--title', 'Demo'], { cwd: dir, home }).status, 0);
  const leased = runCx(['stack', 'lease', 'demo'], { cwd: dir, home });
  assert.equal(leased.status, 0, leased.stderr);
  assert.equal(fs.existsSync(path.join(dir, '.cx', 'stack', 'lease')), true);
  const ended = hook(leaseHook, dir, { hook_event_name: 'SessionEnd', cwd: dir });
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.stderr, /released/);
  assert.equal(fs.existsSync(path.join(dir, '.cx', 'stack', 'lease')), false);
});

test('primary checkout edits are refused and worktree edits are allowed', () => {
  const dir = tempDir('cx-primary-');
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'cx-test@example.com']);
  git(['config', 'user.name', 'cx test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'init']);
  const home = tempDir('cx-primary-home-');
  assert.equal(runCx(['init', '--preset', 'single-repo'], { cwd: dir, home }).status, 0);
  assert.equal(runCx(['task', 'new', 'demo', '--title', 'Demo'], { cwd: dir, home }).status, 0);
  const cfg = loadConfig({ startDir: dir, home: '' });
  const worktree = path.resolve(dir, readState(cfg, 'demo').lanes[0].worktree);
  const blocked = hook(editHook, dir, {
    tool_name: 'Edit',
    cwd: dir,
    tool_input: { file_path: path.join(dir, 'README.md'), new_string: 'nope' },
  });
  assert.equal(blocked.status, 2, blocked.stderr);
  const allowed = hook(editHook, dir, {
    tool_name: 'Edit',
    cwd: dir,
    tool_input: { file_path: path.join(worktree, 'README.md'), new_string: 'ok' },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('redact hides tokens and assignments', () => {
  const text = redact('Bearer abcdefghijk and ghp_abcdefghijklmnopqrst and NPM_TOKEN=supersecret');
  assert.equal(text.includes('supersecret'), false);
  assert.equal(text.includes('ghp_abcdefghijklmnop'), false);
  assert.match(text, /NPM_TOKEN=\[redacted\]/);
});

function hook(
  script: string,
  cwd: string,
  payload: unknown,
  envPairs: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('/usr/bin/env', ['-i', ...envPairs, process.execPath, script], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
