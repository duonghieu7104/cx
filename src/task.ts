import fs from 'node:fs';
import path from 'node:path';
import { findRepo, type Config, type RepoConfig } from './config.js';
import { CxError } from './errors.js';
import { runShell, shellError, writeLog } from './exec.js';
import { gitOk, hasRemote, isDirty, isUnpushed, refExists, shortSha, worktreeList } from './git.js';
import { withQueue } from './queue.js';
import {
  blankState,
  createTaskFiles,
  laneAbs,
  readState,
  taskDir,
  taskExists,
  updateState,
  type LaneState,
  type TaskState,
} from './state.js';
import { assertSlug, formatPattern, mkdirp } from './util.js';

export interface TaskNewOptions {
  task: string;
  title: string;
  repos?: string[];
  type?: string;
  desc?: string;
  branch?: string;
  dryRun?: boolean;
  fetch?: boolean;
}

export function taskNew(cfg: Config, opts: TaskNewOptions): TaskState {
  assertSlug(opts.task);
  const title = opts.title.trim();
  if (!title) throw new CxError('--title is required');
  const selected = selectRepos(cfg, opts.repos);
  if (opts.dryRun) {
    const lines = selected.map((repo) => `lane ${repo.id} branch ${branchName(cfg, opts, repo)} worktree ${worktreePath(cfg, opts, repo).abs}`);
    console.log(`dry-run: would create task ${opts.task}\n${lines.join('\n')}`);
    return blankState(opts.task, title);
  }
  if (!taskExists(cfg, opts.task)) {
    const state = blankState(opts.task, title);
    const first = cfg.phases.find((phase) => phase.enabled);
    state.phase = first?.id ?? 'intake';
    createTaskFiles(cfg, state);
  }
  for (const repo of selected) addLane(cfg, opts.task, repo, opts);
  return readState(cfg, opts.task);
}

export function addLane(cfg: Config, task: string, repoOrName: RepoConfig | string, opts: TaskNewOptions): LaneState {
  if (!taskExists(cfg, task)) throw new CxError(`task ${task} does not exist`);
  const repo = typeof repoOrName === 'string' ? findRepo(cfg, repoOrName) : repoOrName;
  const existing = readState(cfg, task).lanes.find((lane) => lane.repo === repo.id);
  const location = worktreePath(cfg, { ...opts, task }, repo);
  if (existing && fs.existsSync(location.abs)) return existing;
  if (opts.dryRun) {
    console.log(`dry-run: would add lane ${repo.id} at ${location.abs}`);
    return {
      repo: repo.id,
      worktree: location.stored,
      branch: opts.branch ?? branchName(cfg, { ...opts, task }, repo),
      base: repo.base,
      services: repo.services,
      status: 'dry-run',
    };
  }
  const gitDir = gitDirOf(repo);
  const branch = opts.branch ?? branchName(cfg, { ...opts, task }, repo);
  if (opts.fetch !== false && hasRemote(gitDir)) {
    const fetched = gitOkSafe(gitDir, ['fetch', 'origin']);
    if (!fetched) {
      process.stderr.write(`warning: git fetch origin failed in ${repo.id}; using the local ${repo.base}\n`);
    }
  }
  let start = repo.base;
  if (hasRemote(gitDir) && refExists(gitDir, `origin/${repo.base}`)) start = `origin/${repo.base}`;
  else if (!refExists(gitDir, repo.base)) {
    throw new CxError(`base branch ${repo.base} not found in ${repo.id} (${gitDir})`);
  }
  const listed = worktreeList(gitDir).some((entry) => path.resolve(entry) === path.resolve(location.abs));
  if (!listed) {
    if (fs.existsSync(location.abs)) throw new CxError(`path exists and is not a git worktree: ${location.abs}`);
    mkdirp(path.dirname(location.abs));
    if (refExists(gitDir, `refs/heads/${branch}`)) gitOk(gitDir, ['worktree', 'add', location.abs, branch]);
    else gitOk(gitDir, ['worktree', 'add', '-b', branch, location.abs, start]);
  }
  const lane: LaneState = {
    repo: repo.id,
    worktree: location.stored,
    branch,
    base: repo.base,
    services: repo.services,
    status: 'created',
  };
  updateState(cfg, task, (state) => {
    state.lanes = state.lanes.filter((item) => item.repo !== repo.id);
    state.lanes.push(lane);
  });
  return lane;
}

export function removeLane(cfg: Config, task: string, repoName: string, force: boolean): void {
  const repo = findRepo(cfg, repoName);
  const state = readState(cfg, task);
  const lane = state.lanes.find((item) => item.repo === repo.id);
  if (!lane) throw new CxError(`task ${task} has no lane for ${repo.id}`);
  const abs = laneAbs(cfg, lane);
  const gitDir = gitDirOf(repo);
  if (fs.existsSync(abs)) {
    if (!force && isDirty(abs)) throw new CxError(`worktree ${lane.worktree} has uncommitted changes. Commit, or pass --force.`);
    if (!force && isUnpushed(abs)) {
      throw new CxError(`branch ${lane.branch} is not pushed. Pass --force to remove the worktree and keep the branch.`);
    }
    const args = force ? ['worktree', 'remove', '--force', abs] : ['worktree', 'remove', abs];
    gitOk(gitDir, args);
  }
  updateState(cfg, task, (current) => {
    current.lanes = current.lanes.filter((item) => item.repo !== repo.id);
  });
}

export function parkTask(cfg: Config, task: string): TaskState {
  return updateState(cfg, task, (state) => {
    if (state.phase === 'parked') return;
    state.resume_phase = state.phase;
    state.phase = 'parked';
    state.summary = 'parked';
  });
}

export function resumeTask(cfg: Config, task: string): TaskState {
  return updateState(cfg, task, (state) => {
    const next = state.resume_phase && state.resume_phase !== 'parked' && state.resume_phase !== 'blocked'
      ? state.resume_phase
      : 'execute';
    state.phase = state.phase === 'blocked' ? 'execute' : next;
    state.summary = `resumed at ${state.phase}`;
    state.resume_phase = undefined;
  });
}

export function runChecks(cfg: Config, task: string, repoName?: string): void {
  const state = readState(cfg, task);
  const lanes = filterLanes(cfg, state, repoName);
  for (const lane of lanes) {
    const repo = findRepo(cfg, lane.repo);
    if (!repo.check.trim()) {
      throw new CxError(`no check command configured for ${repo.id}. Set workspace.repos[].check. cx will not guess from the README.`);
    }
    const cwd = laneAbs(cfg, lane);
    withQueue(cfg, task, `check-${repo.id}`, () => {
      const result = runShell(repo.check, cwd);
      writeLog(logFile(cfg, task, `checks-${repo.id}.log`), result);
      if (result.status !== 0) throw shellError(repo.check, result);
    });
    updateState(cfg, task, (current) => {
      const item = current.lanes.find((laneItem) => laneItem.repo === repo.id);
      if (item) item.status = 'checks-green';
      current.summary = `checks green for ${repo.id}`;
    });
  }
}

export function runBuild(cfg: Config, task: string, serviceName: string): { tag: string } {
  const state = readState(cfg, task);
  const spec = cfg.stack.services.find((service) => service.name === serviceName);
  const lane = spec?.repo
    ? state.lanes.find((item) => item.repo === spec.repo)
    : state.lanes.find((item) => item.services.includes(serviceName)) ?? state.lanes[0];
  if (!lane) throw new CxError(`task ${task} has no lane to build ${serviceName}`);
  const repo = findRepo(cfg, lane.repo);
  const template = spec?.build || repo.build;
  if (!template.trim()) throw new CxError(`no build command for ${serviceName}. Set stack.services[].build or repos[].build.`);
  const cwd = laneAbs(cfg, lane);
  const sha = shortSha(cwd);
  const tag = `cx-${task}-${sha.sha}${sha.dirty ? '-dirty' : ''}`;
  const command = template
    .replaceAll('{tag}', tag)
    .replaceAll('{task}', task)
    .replaceAll('{repo}', repo.id)
    .replaceAll('{worktree}', cwd)
    .replaceAll('{image}', spec?.image ?? serviceName);
  withQueue(cfg, task, `build-${serviceName}`, () => {
    const result = runShell(command, cwd, { ...process.env, CX_TAG: tag, CX_TASK: task });
    writeLog(logFile(cfg, task, `build-${serviceName}.log`), result);
    if (result.status !== 0) throw shellError(command, result);
  });
  updateState(cfg, task, (current) => {
    const item = current.lanes.find((laneItem) => laneItem.repo === repo.id);
    if (item) item.status = `built:${tag}`;
    current.summary = `built ${serviceName} as ${tag}`;
  });
  return { tag };
}

export function testLocal(cfg: Config, task: string): string {
  const folder = cfg.tasks.folders.test_local ?? '5-test';
  const file = path.join(taskDir(cfg, task), folder, 'REPORT.md');
  mkdirp(path.dirname(file));
  const body = [
    `# Test local — ${task}`,
    '',
    `Stack mode: ${cfg.stack.mode}.`,
    '',
    'Browser QC is a later milestone. This command did not read `.env` files, did not print credentials, and did not launch a browser.',
    '',
    'Limits: local proof only. Re-run with a future runner when you want screenshots.',
    '',
  ].join('\n');
  fs.writeFileSync(file, body);
  updateState(cfg, task, (state) => {
    state.summary = 'test-local report written (runner stub)';
  });
  return file;
}

function filterLanes(cfg: Config, state: TaskState, repoName?: string): LaneState[] {
  if (!repoName) {
    if (state.lanes.length === 0) throw new CxError('task has no lanes');
    return state.lanes;
  }
  const repo = findRepo(cfg, repoName);
  const lanes = state.lanes.filter((lane) => lane.repo === repo.id);
  if (lanes.length === 0) throw new CxError(`task ${state.task} has no lane for ${repo.id}`);
  return lanes;
}

function logFile(cfg: Config, task: string, name: string): string {
  const folder = cfg.tasks.folders.execute ?? '4-execute';
  return path.join(taskDir(cfg, task), folder, 'exec-log', name);
}

function selectRepos(cfg: Config, names: string[] | undefined): RepoConfig[] {
  if (!names || names.length === 0) return cfg.workspace.repos;
  return names.map((name) => findRepo(cfg, name));
}

function gitDirOf(repo: RepoConfig): string {
  if (repo.checkoutPath) {
    if (!fs.existsSync(path.join(repo.checkoutPath, '.git')) && !fs.existsSync(repo.checkoutPath)) {
      throw new CxError(`checkout for ${repo.id} does not exist: ${repo.checkout}`);
    }
    if (!fs.existsSync(repo.checkoutPath)) throw new CxError(`checkout for ${repo.id} does not exist: ${repo.checkout}`);
    return repo.checkoutPath;
  }
  if (!fs.existsSync(repo.absPath)) throw new CxError(`repo path does not exist for ${repo.id}: ${repo.path}`);
  return repo.absPath;
}

function worktreePath(cfg: Config, opts: TaskNewOptions, repo: RepoConfig): { abs: string; stored: string } {
  const formatted = formatPattern(cfg.worktree.pattern, {
    task: opts.task,
    repo: repo.id,
    alias: repo.alias[0] ?? repo.id,
    type: laneType(opts.type),
    desc: opts.desc ?? opts.task,
  });
  const abs = path.resolve(cfg.worktree.absRoot, formatted);
  const stored = path.relative(cfg.workspaceRoot, abs) || formatted;
  return { abs, stored };
}

function branchName(cfg: Config, opts: TaskNewOptions, repo: RepoConfig): string {
  return formatPattern(cfg.worktree.branch_pattern, {
    task: opts.task,
    repo: repo.id,
    alias: repo.alias[0] ?? repo.id,
    type: laneType(opts.type),
    desc: opts.desc ?? opts.task,
  });
}

function laneType(type: string | undefined): string {
  const value = type ?? 'feat';
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new CxError(`--type must be a short slug, got ${type}`);
  return value;
}

function gitOkSafe(cwd: string, args: string[]): boolean {
  try {
    gitOk(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function addLaneNamed(cfg: Config, task: string, repoName: string, opts: TaskNewOptions): LaneState {
  return addLane(cfg, task, repoName, { ...opts, task, title: opts.title || task });
}
