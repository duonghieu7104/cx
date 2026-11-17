import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, presetNames, readPreset } from '../src/config.js';
import { gitInit, repoRoot, runCx, tempDir } from './helpers.js';

test('presets validate, including cluega', () => {
  assert.deepEqual(presetNames().sort(), ['cluega', 'multi-repo', 'single-repo']);
  for (const name of presetNames()) {
    const dir = tempDir(`cx-preset-${name}-`);
    fs.writeFileSync(path.join(dir, 'cx.config.yaml'), readPreset(name).text);
    const loaded = loadConfig({ startDir: dir, home: '' });
    assert.equal(loaded.version, 1);
    assert.ok(loaded.phases.length > 0);
  }
  const cluega = loadConfig({
    startDir: writePreset('cluega'),
    home: '',
  });
  assert.equal(cluega.workspace.mode, 'multi-repo');
  assert.equal(cluega.stack.mode, 'shared');
  assert.equal(cluega.stack.project, 'cluega-local');
  assert.equal(cluega.tasks.root, 'plans');
  assert.equal(cluega.worktree.pattern, '{task}-{repo}');
  const fe = cluega.workspace.repos.find((repo) => repo.alias.includes('FE'));
  assert.equal(fe?.base, 'dev');
  const extension = cluega.workspace.repos.find((repo) => repo.id === 'EXTENSION_CDP_CLUEGA');
  assert.equal(extension?.base, 'main');
  assert.equal(cluega.stack.services.find((service) => service.name === 'fe')?.kind, 'mount');
});

test('config errors name the field', () => {
  const dir = tempDir('cx-bad-');
  fs.writeFileSync(
    path.join(dir, 'cx.config.yaml'),
    'version: 1\nworkspace:\n  mode: both\n  repos: []\nphases: []\n',
  );
  const result = runCx(['config', 'validate'], { cwd: dir, home: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace\.mode/);
  assert.match(result.stderr, /single-repo \| multi-repo/);
});

test('shared stack requires a wrapper', () => {
  const dir = tempDir('cx-shared-');
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
`,
  );
  const result = runCx(['config', 'validate'], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stack\.wrapper/);
});

test('user overlay changes cooldown and cannot erase a project guard', () => {
  const dir = tempDir('cx-merge-');
  const home = tempDir('cx-merge-home-');
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
  - id: gate
    actor: human
    gate: commit
queue:
  cooldown: 60s
guards:
  blocked_commands:
    - pattern: '\\bgit\\s+push\\b'
      reason: no push
`,
  );
  fs.mkdirSync(path.join(home, '.config', 'cx'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'cx', 'config.yaml'),
    `queue:
  cooldown: 5s
notifications:
  on_gate: none
guards:
  blocked_commands:
    - pattern: '\\brm\\s+-rf\\b'
      reason: no wipe
`,
  );
  const loaded = loadConfig({ startDir: dir, home });
  assert.equal(loaded.queue.cooldown, '5s');
  assert.equal(loaded.notifications.on_gate, 'none');
  assert.equal(loaded.workspace.repos[0].id, 'app');
  const patterns = loaded.guards.blocked_commands.map((rule) => rule.pattern);
  assert.ok(patterns.some((pattern) => pattern.includes('git')));
  assert.ok(patterns.some((pattern) => pattern.includes('rm')));
});

test('minimal config picks up defaults', () => {
  const dir = tempDir('cx-min-');
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
  - id: gate
    actor: human
    gate: commit
`,
  );
  const loaded = loadConfig({ startDir: dir, home: '' });
  assert.equal(loaded.stack.mode, 'none');
  assert.equal(loaded.tasks.root, 'docs/tasks');
  assert.equal(loaded.gates.bind_to_head, true);
  assert.ok(loaded.tasks.folders.proposal);
});

test('tracked files do not contain live secrets', () => {
  const roots = ['presets', 'claude', 'prompts', 'dashboard', 'README.md', 'src'].map((entry) =>
    path.join(repoRoot, entry),
  );
  const banned = [/ghp_[A-Za-z0-9]{8}/, /gho_[A-Za-z0-9]{8}/, /BEGIN PRIVATE KEY/, /sk-[A-Za-z0-9]{12}/];
  for (const file of walk(roots)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${file} matched ${pattern}`);
    }
  }
});

function writePreset(name: string): string {
  const dir = tempDir(`cx-${name}-`);
  fs.writeFileSync(path.join(dir, 'cx.config.yaml'), readPreset(name).text);
  return dir;
}

function walk(entries: string[]): string[] {
  const files: string[] = [];
  for (const entry of entries) {
    if (!fs.existsSync(entry)) continue;
    const stat = fs.statSync(entry);
    if (stat.isFile()) {
      files.push(entry);
      continue;
    }
    for (const child of fs.readdirSync(entry)) {
      if (child === 'node_modules' || child === 'dist') continue;
      files.push(...walk([path.join(entry, child)]));
    }
  }
  return files;
}

test('init single-repo uses the current branch', () => {
  const dir = tempDir('cx-init-');
  gitInit(dir, 'develop');
  const result = runCx(['init', '--preset', 'single-repo'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(path.join(dir, 'cx.config.yaml'), 'utf8');
  assert.match(text, /base: develop/);
  const again = runCx(['config', 'validate'], { cwd: dir, home: result.home });
  assert.equal(again.status, 0, again.stderr);
});
