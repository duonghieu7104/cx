import fs from 'node:fs';
import path from 'node:path';
import { findRepo, type Config } from './config.js';
import { CxError } from './errors.js';
import { runCommand } from './exec.js';
import { fingerprint, git, gitOk } from './git.js';
import { redact } from './redact.js';
import { laneAbs, readState, taskDir, updateState, type Approval, type HeadBinding, type TaskState } from './state.js';
import { isoNow, matchAnyGlob, mkdirp } from './util.js';

const SKIP_PREFIXES = ['.gitnexus/', '.claude/', '.agents/'];

export function calledByAgent(): boolean {
  return process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE === '1' || process.env.CX_ACTOR === 'agent';
}

export function approve(cfg: Config, task: string, what: string, note = ''): Approval {
  if (calledByAgent()) {
    throw new CxError('cx approve is reserved for a human. Run it in your own terminal, not from Claude.');
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(what)) throw new CxError(`approval name must be a slug, got ${what}`);
  const state = readState(cfg, task);
  if (state.lanes.length === 0) throw new CxError(`task ${task} has no lanes to bind an approval to`);
  const record: Approval = {
    what,
    by: 'human',
    ts: isoNow(),
    note,
    heads: bindings(cfg, state),
  };
  updateState(cfg, task, (current) => {
    current.approvals = current.approvals.filter((item) => item.what !== what);
    current.approvals.push(record);
    current.summary = `approved ${what}`;
  });
  return record;
}

export function recordAutoApproval(cfg: Config, task: string, what: string, note: string): void {
  const state = readState(cfg, task);
  const record: Approval = {
    what,
    by: 'auto',
    ts: isoNow(),
    note,
    heads: state.lanes.length ? bindings(cfg, state) : [],
  };
  updateState(cfg, task, (current) => {
    current.approvals = current.approvals.filter((item) => item.what !== what);
    current.approvals.push(record);
  });
}

export function approvalState(cfg: Config, task: string, what: string): { ok: boolean; reason: string } {
  const state = readState(cfg, task);
  const approval = [...state.approvals].reverse().find((item) => item.what === what);
  if (!approval) return { ok: false, reason: `no ${what} approval on ${task}` };
  if (!cfg.gates.bind_to_head) return { ok: true, reason: `${what} approval present (bind_to_head is off)` };
  for (const lane of state.lanes) {
    const recorded = approval.heads.find((head) => head.repo === lane.repo);
    if (!recorded) return { ok: false, reason: `${what} approval does not cover ${lane.repo}` };
    const current = fingerprint(laneAbs(cfg, lane));
    if (current.head !== recorded.head || current.content !== recorded.content) {
      return {
        ok: false,
        reason: `${what} approval for ${lane.repo} is stale (HEAD or working tree changed after ${approval.ts})`,
      };
    }
  }
  return { ok: true, reason: `${what} approval matches HEAD` };
}

export function requireApproval(cfg: Config, task: string, what: string): void {
  if (!cfg.gates.require.includes(what)) return;
  const status = approvalState(cfg, task, what);
  if (!status.ok) throw new CxError(status.reason);
}

export function commitTask(cfg: Config, task: string, message: string, repoName?: string): string[] {
  requireApproval(cfg, task, 'commit');
  const state = readState(cfg, task);
  const lanes = repoName ? state.lanes.filter((lane) => lane.repo === findRepo(cfg, repoName).id) : state.lanes;
  if (lanes.length === 0) throw new CxError('no lanes to commit');
  const committed: string[] = [];
  for (const lane of lanes) {
    const cwd = laneAbs(cfg, lane);
    gitOk(cwd, ['add', '-A']);
    const staged = gitOk(cwd, ['diff', '--cached', '--name-only'])
      .split('\n')
      .filter(Boolean);
    for (const file of staged) {
      if (skipFile(file)) gitOk(cwd, ['reset', '-q', '--', file]);
    }
    const remaining = gitOk(cwd, ['diff', '--cached', '--name-only'])
      .split('\n')
      .filter(Boolean);
    const protectedHit = remaining.find((file) => matchAnyGlob(cfg.guards.protected_files, file));
    if (protectedHit) {
      gitOk(cwd, ['reset', '-q', '--', protectedHit]);
      throw new CxError(`refusing to commit protected file ${protectedHit}`);
    }
    if (remaining.length === 0) throw new CxError(`nothing to commit in ${lane.repo}`);
    gitOk(cwd, ['commit', '-m', message]);
    committed.push(lane.repo);
  }
  updateState(cfg, task, (current) => {
    for (const lane of current.lanes) {
      if (committed.includes(lane.repo)) lane.status = 'committed';
    }
    current.summary = `committed ${committed.join(', ')}`;
  });
  return committed;
}

export function preparePullRequest(
  cfg: Config,
  task: string,
  opts: { submit: boolean; repo?: string },
): { file: string; submitted: string[] } {
  requireApproval(cfg, task, 'push');
  requireApproval(cfg, task, 'pr');
  const state = readState(cfg, task);
  const file = path.join(taskDir(cfg, task), 'PR.md');
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, redact(renderPrBody(cfg, task, state)));
  const submitted: string[] = [];
  if (!opts.submit) return { file, submitted };
  const only = opts.repo;
  const lanes = only ? state.lanes.filter((lane) => lane.repo === findRepo(cfg, only).id) : state.lanes;
  const gh = process.env.CX_GH || 'gh';
  for (const lane of lanes) {
    const cwd = laneAbs(cfg, lane);
    const repo = findRepo(cfg, lane.repo);
    const pushed = runCommand('git', ['push', '-u', 'origin', 'HEAD'], { cwd });
    if (pushed.status !== 0) {
      throw new CxError(`git push failed for ${lane.repo}: ${redact(pushed.stderr || pushed.stdout).trim()}`);
    }
    const created = runCommand(
      gh,
      ['pr', 'create', '--base', repo.base, '--title', state.title, '--body-file', file],
      { cwd },
    );
    if (created.status !== 0) {
      throw new CxError(`gh pr create failed for ${lane.repo}: ${redact(created.stderr || created.stdout).trim()}`);
    }
    const url = (created.stdout.match(/https?:\/\/\S+/) ?? [])[0] ?? created.stdout.trim();
    submitted.push(url);
    updateState(cfg, task, (current) => {
      current.prs.push({ repo: lane.repo, url, base: repo.base });
      current.summary = `opened PR for ${lane.repo}`;
    });
  }
  return { file, submitted };
}

function bindings(cfg: Config, state: TaskState): HeadBinding[] {
  return state.lanes.map((lane) => ({ repo: lane.repo, ...fingerprint(laneAbs(cfg, lane)) }));
}

function skipFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  if (normalized.endsWith('.md') || normalized.endsWith('/SKILL.md') || normalized === 'SKILL.md') return true;
  return SKIP_PREFIXES.some((prefix) => normalized.startsWith(prefix) || normalized.includes(`/${prefix}`));
}

function renderPrBody(cfg: Config, task: string, state: TaskState): string {
  const dir = taskDir(cfg, task);
  const parts = [`# ${state.title}`, '', `Task: ${task}`, ''];
  const plan = firstExisting(dir, [path.join(cfg.tasks.folders.plan ?? '2-plan', 'PLAN.md')]);
  const review = newestReview(dir, cfg.tasks.folders.review ?? '4-execute');
  const report = firstExisting(dir, [path.join(cfg.tasks.folders.test_local ?? '5-test', 'REPORT.md')]);
  if (plan) parts.push('## Plan', '', clip(fs.readFileSync(plan, 'utf8')), '');
  if (review) parts.push('## Review', '', clip(fs.readFileSync(review, 'utf8')), '');
  if (report) parts.push('## Local test', '', clip(fs.readFileSync(report, 'utf8')), '');
  parts.push('Proof paths are inside the task record. This body was generated by cx and does not include environment files.');
  return parts.join('\n');
}

function firstExisting(dir: string, rels: string[]): string | undefined {
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return undefined;
}

function newestReview(dir: string, folder: string): string | undefined {
  const abs = path.join(dir, folder);
  if (!fs.existsSync(abs)) return undefined;
  const files = fs.readdirSync(abs).filter((name) => /^REVIEW-\d+\.md$/.test(name)).sort();
  if (files.length === 0) return undefined;
  return path.join(abs, files[files.length - 1]);
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n…` : trimmed;
}

export function gitStatusShort(cwd: string): string {
  return git(cwd, ['status', '--porcelain']).stdout;
}
