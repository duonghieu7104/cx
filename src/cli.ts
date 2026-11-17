import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalState, approve, commitTask, preparePullRequest } from './approve.js';
import { jsonSchema, loadConfig, presetNames, publicConfig, type Config } from './config.js';
import { doctor, formatDoctor } from './doctor.js';
import { CxError } from './errors.js';
import { runHook } from './hook.js';
import { initFromInspect, initPreset } from './init.js';
import { inspectProject } from './inspect.js';
import { installClaude, uninstallClaude } from './install.js';
import { queueSnapshot } from './queue.js';
import { redact } from './redact.js';
import { describePhases, phasePrompt, shipTask } from './ship.js';
import { listTaskIds, readState } from './state.js';
import {
  acquireLease,
  recoverLease,
  releaseLease,
  showBaseline,
  stackDown,
  stackStatus,
  stackUp,
  swapService,
} from './stack.js';
import { addLaneNamed, parkTask, removeLane, resumeTask, runBuild, runChecks, taskNew, testLocal } from './task.js';

interface Flags {
  [key: string]: string | boolean;
}

const BOOLEANS = new Set([
  'json',
  'force',
  'yes',
  'auto-plan',
  'dry-run',
  'submit',
  'help',
  'version',
  'from-inspect',
  'uninstall',
  'wait',
  'all',
]);

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const code = await dispatch(argv);
    process.exit(code);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(redact(message));
    process.exit(err instanceof CxError ? err.exitCode : 1);
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  if (bool(flags, 'version') || positionals[0] === 'version') {
    console.log('cx 0.1.0');
    return 0;
  }
  if (positionals.length === 0 || bool(flags, 'help') || positionals[0] === 'help') {
    console.log(HELP);
    return 0;
  }
  const [group, action, ...rest] = positionals;
  if (group === 'init') return cmdInit(flags);
  if (group === 'config') return cmdConfig(action, flags);
  if (group === 'inspect') return cmdInspect(flags);
  if (group === 'doctor') return cmdDoctor(flags);
  if (group === 'hook') return runHook(requireHook(action));
  if (group === 'install') return cmdInstall(flags);
  if (group === 'dash' || group === 'dashboard') {
    console.log('Dashboard is milestone M5 and is not running. See dashboard/PLAN.md.');
    return 0;
  }
  const cfg = loadLoaded(flags);
  if (group === 'task') return cmdTask(cfg, action, rest, flags);
  if (group === 'lane') return cmdLane(cfg, action, rest, flags);
  if (group === 'stack') return cmdStack(cfg, action, rest, flags);
  if (group === 'build') return cmdBuild(cfg, action, rest[0]);
  if (group === 'queue') {
    console.log(bool(flags, 'json') ? JSON.stringify(queueSnapshot(cfg), null, 2) : formatQueue(cfg));
    return 0;
  }
  if (group === 'check') {
    runChecks(cfg, requireName(action, 'task'), rest[0]);
    console.log('checks passed');
    return 0;
  }
  if (group === 'test-local') {
    const file = testLocal(cfg, requireName(action, 'task'));
    console.log(file);
    return 0;
  }
  if (group === 'approve') return cmdApprove(cfg, action, rest, flags);
  if (group === 'commit') {
    const repos = commitTask(cfg, requireName(action, 'task'), str(flags, 'm') ?? str(flags, 'message') ?? `cx: ${action}`, rest[0]);
    console.log(`committed ${repos.join(', ')}`);
    return 0;
  }
  if (group === 'pr') return cmdPr(cfg, action, rest, flags);
  if (group === 'ship') return cmdShip(cfg, action, flags);
  if (group === 'phase' && action === 'prompt') {
    console.log(phasePrompt(cfg, requireName(rest[0], 'task'), rest[1]));
    return 0;
  }
  if (group === 'status') {
    printStatus(cfg, action, bool(flags, 'json'));
    return 0;
  }
  if (group === 'phases') {
    console.log(describePhases(cfg));
    return 0;
  }
  throw new CxError(`unknown command ${group}. Run cx help.`);
}

function cmdInit(flags: Flags): number {
  const cwd = process.cwd();
  const home = str(flags, 'home');
  if (bool(flags, 'from-inspect')) {
    const file = initFromInspect(cwd, { force: bool(flags, 'force'), home });
    console.log(`wrote ${file}`);
    return 0;
  }
  const preset = str(flags, 'preset');
  if (!preset) throw new CxError(`pass --preset ${presetNames().join('|')} or --from-inspect`);
  const file = initPreset(cwd, preset, { force: bool(flags, 'force'), home });
  console.log(`wrote ${file}`);
  console.log('next: cx config validate && cx doctor');
  return 0;
}

function cmdConfig(action: string | undefined, flags: Flags): number {
  if (action === 'schema') {
    console.log(JSON.stringify(jsonSchema(), null, 2));
    return 0;
  }
  const cfg = loadLoaded(flags);
  if (!action || action === 'validate') {
    console.log(`config ok\nproject: ${cfg.configPath}${cfg.userConfigPath ? `\nuser: ${cfg.userConfigPath}` : ''}`);
    return 0;
  }
  if (action === 'print') {
    const payload = publicConfig(cfg);
    console.log(bool(flags, 'json') ? JSON.stringify(payload, null, 2) : JSON.stringify(payload, null, 2));
    return 0;
  }
  throw new CxError('usage: cx config validate|print|schema');
}

function cmdInspect(flags: Flags): number {
  const report = inspectProject(process.cwd(), str(flags, 'home'));
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

function cmdDoctor(flags: Flags): number {
  const result = doctor(process.cwd(), str(flags, 'home'));
  console.log(bool(flags, 'json') ? JSON.stringify(result, null, 2) : formatDoctor(result.lines));
  return result.ok ? 0 : 1;
}

function cmdInstall(flags: Flags): number {
  const home = str(flags, 'home') ?? process.env.HOME;
  const scope = str(flags, 'scope') ?? 'project';
  const claudeDir =
    str(flags, 'claude-dir') ?? (scope === 'user' ? path.join(home ?? '', '.claude') : path.join(process.cwd(), '.claude'));
  if (!claudeDir || claudeDir === '.claude' && !home && scope === 'user') {
    throw new CxError('pass --claude-dir or set HOME');
  }
  if (bool(flags, 'uninstall')) {
    const result = uninstallClaude(claudeDir);
    console.log(`removed ${result.removed.length}, kept ${result.kept.length}`);
    return 0;
  }
  const result = installClaude({ claudeDir });
  console.log(`installed into ${result.claudeDir}`);
  if (result.wrote.length) console.log(`wrote ${result.wrote.join(', ')}`);
  if (result.skipped.length) console.log(`kept existing files: ${result.skipped.join(', ')}`);
  console.log(`hooks merged into ${result.settings}`);
  return 0;
}

function cmdTask(cfg: Config, action: string | undefined, rest: string[], flags: Flags): number {
  if (action === 'new') {
    const repos = str(flags, 'repos');
    const state = taskNew(cfg, {
      task: requireName(rest[0], 'task'),
      title: str(flags, 'title') ?? '',
      repos: repos ? repos.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      type: str(flags, 'type'),
      desc: str(flags, 'desc'),
      dryRun: bool(flags, 'dry-run'),
    });
    if (!bool(flags, 'dry-run')) console.log(`task ${state.task} phase ${state.phase} lanes ${state.lanes.length}`);
    return 0;
  }
  if (action === 'list') {
    const ids = listTaskIds(cfg);
    if (bool(flags, 'json')) console.log(JSON.stringify(ids.map((id) => readState(cfg, id)), null, 2));
    else console.log(ids.join('\n'));
    return 0;
  }
  if (action === 'status' || !action) {
    printStatus(cfg, rest[0], bool(flags, 'json'));
    return 0;
  }
  if (action === 'park') {
    const state = parkTask(cfg, requireName(rest[0], 'task'));
    console.log(`${state.task} ${state.phase}`);
    return 0;
  }
  if (action === 'resume') {
    const state = resumeTask(cfg, requireName(rest[0], 'task'));
    console.log(`${state.task} ${state.phase}`);
    return 0;
  }
  throw new CxError('usage: cx task new|list|status|park|resume');
}

function cmdLane(cfg: Config, action: string | undefined, rest: string[], flags: Flags): number {
  if (action === 'add') {
    const lane = addLaneNamed(cfg, requireName(rest[0], 'task'), requireName(rest[1], 'repo'), {
      task: rest[0],
      title: rest[0],
      type: str(flags, 'type'),
      desc: str(flags, 'desc'),
      branch: str(flags, 'branch'),
      dryRun: bool(flags, 'dry-run'),
    });
    console.log(`${lane.repo} ${lane.branch} ${lane.worktree}`);
    return 0;
  }
  if (action === 'rm' || action === 'remove') {
    removeLane(cfg, requireName(rest[0], 'task'), requireName(rest[1], 'repo'), bool(flags, 'force'));
    console.log(`removed lane ${rest[1]}`);
    return 0;
  }
  throw new CxError('usage: cx lane add|rm <task> <repo>');
}

function cmdStack(cfg: Config, action: string | undefined, rest: string[], flags: Flags): number {
  if (!action || action === 'status') {
    const status = stackStatus(cfg);
    console.log(bool(flags, 'json') ? JSON.stringify(status, null, 2) : formatStack(status));
    return 0;
  }
  if (action === 'lease') {
    const result = acquireLease(cfg, requireName(rest[0], 'task'), { ttl: str(flags, 'ttl') });
    if (result.reused) console.log(`lease already held by ${result.task}`);
    else console.log(`CX_LEASE_TOKEN=${result.token}`);
    return 0;
  }
  if (action === 'swap') {
    const token = str(flags, 'token') ?? process.env.CX_LEASE_TOKEN;
    swapService(cfg, requireName(rest[0], 'task'), requireName(rest[1], 'service'), requireName(str(flags, 'tag'), 'tag'), token);
    console.log(`swapped ${rest[1]} -> ${str(flags, 'tag')}`);
    return 0;
  }
  if (action === 'release') {
    releaseLease(cfg, requireName(rest[0], 'task'));
    console.log(`released lease for ${rest[0]}`);
    return 0;
  }
  if (action === 'recover') {
    recoverLease(cfg, { yes: bool(flags, 'yes'), force: bool(flags, 'force') });
    console.log('recovered stack lease');
    return 0;
  }
  if (action === 'up') {
    const args = stackUp(cfg, requireName(rest[0], 'task'));
    console.log(args.join(' '));
    return 0;
  }
  if (action === 'down') {
    const args = stackDown(cfg, requireName(rest[0], 'task'));
    console.log(args.join(' '));
    return 0;
  }
  if (action === 'baseline') {
    console.log(JSON.stringify(showBaseline(cfg), null, 2));
    return 0;
  }
  throw new CxError('usage: cx stack status|lease|swap|release|recover|up|down|baseline');
}

function cmdBuild(cfg: Config, task: string | undefined, service: string | undefined): number {
  const built = runBuild(cfg, requireName(task, 'task'), requireName(service, 'service'));
  console.log(built.tag);
  return 0;
}

function cmdApprove(cfg: Config, action: string | undefined, rest: string[], flags: Flags): number {
  if (action === 'status') {
    const task = requireName(rest[0], 'task');
    const whats = rest[1] ? [rest[1]] : cfg.gates.require;
    const rows = whats.map((what) => ({ what, ...approvalState(cfg, task, what) }));
    console.log(bool(flags, 'json') ? JSON.stringify(rows, null, 2) : rows.map((row) => `${row.ok ? 'ok' : 'stale'} ${row.what}: ${row.reason}`).join('\n'));
    return 0;
  }
  const record = approve(cfg, requireName(action, 'task'), requireName(rest[0], 'what'), str(flags, 'note') ?? '');
  console.log(`approved ${record.what} at ${record.heads.map((head) => head.head.slice(0, 7)).join(',')}`);
  return 0;
}

function cmdPr(cfg: Config, task: string | undefined, rest: string[], flags: Flags): number {
  const result = preparePullRequest(cfg, requireName(task, 'task'), { submit: bool(flags, 'submit'), repo: rest[0] });
  console.log(result.file);
  if (!bool(flags, 'submit')) console.log('PR body written. Re-run with --submit after push and pr approvals to call git and gh.');
  else console.log(result.submitted.join('\n'));
  return 0;
}

async function cmdShip(cfg: Config, task: string | undefined, flags: Flags): Promise<number> {
  const result = await shipTask(cfg, requireName(task, 'task'), {
    autoPlan: bool(flags, 'auto-plan'),
    until: str(flags, 'until'),
  });
  console.log(`${result.phase}: ${result.message}`);
  return result.phase === 'blocked' ? 2 : 0;
}

function printStatus(cfg: Config, task: string | undefined, json: boolean): void {
  const ids = task ? [task] : listTaskIds(cfg);
  const payload = {
    tasks: ids.map((id) => readState(cfg, id)),
    stack: stackStatus(cfg),
    queue: queueSnapshot(cfg),
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.tasks.length === 0) {
    console.log('no tasks');
    return;
  }
  for (const state of payload.tasks) {
    const lanes = state.lanes.map((lane) => `${lane.repo}:${lane.branch}`).join(', ') || '(no lanes)';
    console.log(`${state.task}\t${state.phase}\t${lanes}`);
  }
}

function formatQueue(cfg: Config): string {
  const snapshot = queueSnapshot(cfg);
  const running = snapshot.running.map((item) => `${item.task ?? '?'}:${item.kind ?? '?'}`).join(', ') || 'idle';
  const waiting = snapshot.waiting.map((item) => item.ticket).join(', ') || 'none';
  return `running: ${running}\nwaiting: ${waiting}\ncooldown_ms: ${snapshot.cooldown_ms}`;
}

function formatStack(status: Record<string, unknown>): string {
  return JSON.stringify(status, null, 2);
}

function loadLoaded(flags: Flags): Config {
  return loadConfig({
    startDir: process.cwd(),
    configPath: str(flags, 'config'),
    home: str(flags, 'home'),
  });
}

function requireHook(action: string | undefined): 'bash' | 'edit' | 'mcp' | 'lease' {
  if (action === 'bash' || action === 'edit' || action === 'mcp' || action === 'lease') return action;
  throw new CxError('usage: cx hook bash|edit|mcp|lease');
}

function requireName(value: string | undefined, label: string): string {
  if (!value) throw new CxError(`${label} is required`);
  return value;
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function bool(flags: Flags, key: string): boolean {
  return flags[key] === true;
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const body = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEANS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) flags[body] = true;
    else {
      flags[body] = next;
      i++;
    }
  }
  return { positionals, flags };
}

const HELP = `cx — configurable parallel-feature harness for Claude Code

  cx init --preset single-repo|multi-repo|cluega
  cx init --from-inspect
  cx config validate|print|schema
  cx inspect
  cx doctor
  cx task new <task> --title "..." [--repos a,b] [--type feat] [--desc kebab]
  cx task list|status [task]
  cx task park|resume <task>
  cx lane add|rm <task> <repo>
  cx stack status|lease|swap|release|recover|up|down|baseline
  cx build <task> <service>
  cx queue
  cx check <task> [repo]
  cx test-local <task>
  cx approve <task> <plan|commit|push|pr>
  cx approve status <task>
  cx commit <task> -m "message"
  cx pr <task> [--submit]
  cx ship <task> [--auto-plan] [--until <phase>]
  cx install [--claude-dir DIR] [--scope project|user]
  cx install --uninstall --claude-dir DIR

State is files in the configured task folder. Stack leases use mkdir, not flock.
cx approve is refused when Claude Code is the caller. Hooks load config from the
project directory, not from parent environment variables.
`;

const invokedDirectly = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(redact(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
