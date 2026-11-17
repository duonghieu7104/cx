import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { applyReviewVerdict, readState } from '../src/state.js';
import { withLock } from '../src/util.js';
import { gitInit, runCx, tempDir } from './helpers.js';

test('task new is idempotent and preserves notes', () => {
  const dir = tempDir('cx-task-');
  gitInit(dir);
  assert.equal(runCx(['init', '--preset', 'single-repo'], { cwd: dir }).status, 0);
  const created = runCx(['task', 'new', 'demo', '--title', 'Demo feature', '--type', 'feat'], { cwd: dir });
  assert.equal(created.status, 0, created.stderr);
  const readme = path.join(dir, 'docs', 'tasks', 'demo', 'README.md');
  fs.appendFileSync(readme, '\nkeep me\n');
  const again = runCx(['task', 'new', 'demo', '--title', 'Demo feature'], { cwd: dir, home: created.home });
  assert.equal(again.status, 0, again.stderr);
  const text = fs.readFileSync(readme, 'utf8');
  assert.match(text, /keep me/);
  assert.match(text, /cx:state:begin/);
  const cfg = loadConfig({ startDir: dir, home: '' });
  const state = readState(cfg, 'demo');
  assert.equal(state.phase, 'intake');
  assert.equal(state.lanes.length, 1);
  assert.equal(state.lanes[0].base, 'main');
  assert.ok(fs.existsSync(path.join(dir, state.lanes[0].worktree)));
  const parked = runCx(['task', 'park', 'demo'], { cwd: dir, home: created.home });
  assert.equal(parked.status, 0, parked.stderr);
  assert.match(fs.readFileSync(readme, 'utf8'), /keep me/);
  assert.equal(readState(cfg, 'demo').phase, 'parked');
  assert.equal(runCx(['task', 'resume', 'demo'], { cwd: dir, home: created.home }).status, 0);
  assert.equal(readState(cfg, 'demo').phase, 'intake');
});

test('lane remove refuses a dirty worktree', () => {
  const dir = tempDir('cx-lane-');
  gitInit(dir);
  runCx(['init', '--preset', 'single-repo'], { cwd: dir });
  runCx(['task', 'new', 'demo', '--title', 'Demo'], { cwd: dir });
  const cfg = loadConfig({ startDir: dir, home: '' });
  const worktree = path.resolve(dir, readState(cfg, 'demo').lanes[0].worktree);
  fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'x\n');
  const removed = runCx(['lane', 'rm', 'demo', 'app'], { cwd: dir });
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /uncommitted/);
  const forced = runCx(['lane', 'rm', 'demo', 'app', '--force'], { cwd: dir });
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readState(cfg, 'demo').lanes.length, 0);
});

test('review NO-GO returns to execute and then blocks', () => {
  const state = {
    task: 'demo',
    title: 'Demo',
    phase: 'review',
    updated: '',
    summary: '',
    lanes: [],
    review: { round: 0, verdict: null },
    approvals: [],
    prs: [],
  };
  applyReviewVerdict(state, 'NO-GO', 2, 'execute');
  assert.equal(state.phase, 'execute');
  assert.equal(state.review.round, 1);
  applyReviewVerdict(state, 'NO-GO', 2, 'execute');
  assert.equal(state.phase, 'blocked');
  assert.equal(state.review.verdict, 'NO-GO');
});

test('mkdir lock serializes writers and clears a dead owner', () => {
  const dir = tempDir('cx-lock-');
  const lock = path.join(dir, 'lock');
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(counter, '0');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, at: Date.now() - 10_000 }));
  withLock(lock, () => {
    fs.writeFileSync(counter, '1');
  });
  assert.equal(fs.readFileSync(counter, 'utf8'), '1');
  assert.equal(fs.existsSync(lock), false);
});
