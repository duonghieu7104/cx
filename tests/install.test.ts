import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCx, tempDir } from './helpers.js';

test('install never clobbers and uninstall keeps foreign files', () => {
  const home = tempDir('cx-install-home-');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'commands', 'ship-task.md'), 'custom ship\n');
  fs.writeFileSync(path.join(claude, 'hooks', 'bash-guard.mjs'), 'custom guard\n');
  fs.writeFileSync(
    path.join(claude, 'settings.json'),
    `${JSON.stringify({
      theme: 'dark',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep' }] }] },
    }, null, 2)}\n`,
  );
  const first = runCx(['install', '--claude-dir', claude], { home });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.readFileSync(path.join(claude, 'commands', 'ship-task.md'), 'utf8'), 'custom ship\n');
  assert.equal(fs.readFileSync(path.join(claude, 'hooks', 'bash-guard.mjs'), 'utf8'), 'custom guard\n');
  assert.ok(fs.existsSync(path.join(claude, 'skills', 'cx-setup', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(claude, 'agents', 'cx-reviewer.md')));
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')) as {
    theme: string;
    hooks: { PreToolUse: { matcher?: string; hooks: { command: string }[] }[] };
  };
  assert.equal(settings.theme, 'dark');
  const flat = JSON.stringify(settings);
  assert.match(flat, /echo keep/);
  assert.doesNotMatch(flat, /bash-guard\.mjs/);
  assert.match(flat, /edit-guard\.mjs/);
  const second = runCx(['install', '--claude-dir', claude], { home });
  assert.equal(second.status, 0, second.stderr);
  const twice = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');
  assert.equal(twice.split('edit-guard.mjs').length - 1, 1);
  const removed = runCx(['install', '--uninstall', '--claude-dir', claude], { home });
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(path.join(claude, 'commands', 'ship-task.md'), 'utf8'), 'custom ship\n');
  assert.equal(fs.existsSync(path.join(claude, 'skills', 'cx-setup', 'SKILL.md')), false);
  const after = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8');
  assert.match(after, /echo keep/);
  assert.doesNotMatch(after, /edit-guard\.mjs/);
});
