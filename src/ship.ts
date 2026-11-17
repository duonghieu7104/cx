import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { phaseById, type Config, type PhaseConfig } from './config.js';
import { CxError } from './errors.js';
import { recordAutoApproval } from './approve.js';
import { redact } from './redact.js';
import { applyReviewVerdict, laneAbs, nextEnabledPhase, readState, taskDir, updateState, type TaskState } from './state.js';
import { runChecks, testLocal } from './task.js';
import { atomicWrite, formatPattern, mkdirp, packageRoot } from './util.js';

export interface ShipOptions {
  autoPlan?: boolean;
  until?: string;
}

export interface ShipResult {
  phase: string;
  waiting: boolean;
  message: string;
}

export async function shipTask(cfg: Config, task: string, opts: ShipOptions = {}): Promise<ShipResult> {
  let steps = 0;
  while (steps++ < 40) {
    const state = readState(cfg, task);
    if (state.phase === 'blocked' || state.phase === 'parked' || state.phase === 'done') {
      return { phase: state.phase, waiting: true, message: `stopped in ${state.phase}` };
    }
    const spec = phaseById(cfg, state.phase);
    if (!spec || !spec.enabled) throw new CxError(`phase ${state.phase} is not an enabled phase in this config`);
    if (opts.until && state.phase === opts.until) {
      return { phase: state.phase, waiting: true, message: `stopped at --until ${opts.until}` };
    }
    if (spec.actor === 'human') {
      if (opts.autoPlan && spec.gate === 'plan') {
        recordAutoApproval(cfg, task, 'plan', '--auto-plan');
        if (!moveNext(cfg, task, 'plan approved automatically')) {
          return { phase: 'done', waiting: false, message: 'pipeline finished' };
        }
        continue;
      }
      notify(cfg, task, state.phase);
      const gate = spec.gate ?? 'commit';
      const message = `human gate "${state.phase}". Next: cx approve ${task} ${gate}`;
      updateState(cfg, task, (current) => {
        current.summary = message;
      });
      return { phase: state.phase, waiting: true, message };
    }
    if (spec.command === 'check' || spec.id === 'checks') {
      runChecks(cfg, task);
      if (!moveNext(cfg, task, 'checks finished')) return done();
      continue;
    }
    if (spec.command === 'test-local' || spec.id === 'test_local') {
      testLocal(cfg, task);
      if (!moveNext(cfg, task, 'test-local report written')) return done();
      continue;
    }
    if (spec.actor === 'agent') {
      const output = phaseOutput(cfg, task, spec, readState(cfg, task).review.round);
      const worktree = readState(cfg, task).lanes[0];
      const result = await runAgent(cfg, task, spec, output, worktree ? laneAbs(cfg, worktree) : '');
      writeAgentLog(cfg, task, spec.id, result.stdout, result.stderr);
      if (result.status !== 0) {
        throw new CxError(`agent for ${spec.id} exited ${result.status}: ${redact(result.stderr || result.stdout).slice(0, 500)}`);
      }
      if (spec.id === 'review') {
        const verdict = parseVerdict(result.stdout) ?? parseVerdict(fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '');
        if (!verdict) throw new CxError('reviewer did not return VERDICT: GO or VERDICT: NO-GO');
        const maxRounds = spec.max_rounds ?? 2;
        const retry = spec.retry_phase ?? (phaseById(cfg, 'execute') ? 'execute' : spec.id);
        let blocked = false;
        updateState(cfg, task, (current) => {
          applyReviewVerdict(current, verdict, maxRounds, retry);
          blocked = current.phase === 'blocked';
        });
        if (blocked) return { phase: 'blocked', waiting: true, message: 'review blocked after the round limit' };
        if (verdict === 'NO-GO') continue;
      }
      if (!moveNext(cfg, task, `${spec.id} finished`)) return done();
      continue;
    }
    if (!moveNext(cfg, task, `${spec.id} done`)) return done();
  }
  throw new CxError('ship stopped after too many phase transitions');
}

export function phasePrompt(cfg: Config, task: string, phaseId?: string): string {
  const state = readState(cfg, task);
  const spec = phaseById(cfg, phaseId ?? state.phase);
  if (!spec) throw new CxError(`unknown phase ${phaseId ?? state.phase}`);
  const output = phaseOutput(cfg, task, spec, state.review.round);
  return renderPrompt(cfg, task, spec, output);
}

function moveNext(cfg: Config, task: string, summary: string): boolean {
  const current = readState(cfg, task).phase;
  const next = nextEnabledPhase(cfg, current);
  updateState(cfg, task, (state) => {
    state.phase = next ?? 'done';
    state.summary = summary;
  });
  return Boolean(next);
}

function done(): ShipResult {
  return { phase: 'done', waiting: false, message: 'pipeline finished' };
}

function notify(cfg: Config, task: string, phase: string): void {
  try {
    const mode = cfg.notifications.on_gate;
    const text = `cx: ${task} reached ${phase}`;
    if (mode === 'stdout' || mode === 'none') {
      if (mode === 'stdout') console.log(text);
      return;
    }
    if (mode === 'command' && cfg.notifications.command) {
      const args = cfg.notifications.args.map((arg) =>
        formatPattern(arg, { task, phase, repo: '', alias: '', type: '', desc: '' }),
      );
      spawn(cfg.notifications.command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
      return;
    }
    if (mode === 'osascript') {
      spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "cx"`], {
        stdio: 'ignore',
        detached: true,
      })
        .on('error', () => undefined)
        .unref();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: notification failed: ${message}\n`);
  }
}

function phaseOutput(cfg: Config, task: string, spec: PhaseConfig, round: number): string {
  const folder = cfg.tasks.folders[spec.id] ?? '.';
  const name =
    spec.id === 'proposal'
      ? 'PROPOSAL.md'
      : spec.id === 'plan'
        ? 'PLAN.md'
        : spec.id === 'execute'
          ? 'EXECUTION.md'
          : spec.id === 'review'
            ? `REVIEW-${round + 1}.md`
            : spec.id === 'test_local'
              ? 'REPORT.md'
              : `${spec.id.toUpperCase()}.md`;
  return path.join(taskDir(cfg, task), folder, name);
}

function renderPrompt(cfg: Config, task: string, spec: PhaseConfig, output: string): string {
  const builtin = spec.prompt?.startsWith('builtin:') ? readBuiltin(spec.prompt.slice('builtin:'.length)) : '';
  const custom = spec.prompt && !spec.prompt.startsWith('builtin:') && fs.existsSync(path.resolve(cfg.workspaceRoot, spec.prompt))
    ? fs.readFileSync(path.resolve(cfg.workspaceRoot, spec.prompt), 'utf8')
    : '';
  return [
    `You are running the cx phase "${spec.id}" for task "${task}".`,
    spec.skill ? `If the skill \`${spec.skill}\` is installed, follow it.` : 'No external skill is configured for this phase.',
    spec.subagent ? `Prefer the ${spec.subagent} subagent for the hands-on work.` : '',
    `Write the phase artifact to ${output}.`,
    'Do not commit, push, open a pull request, or run `cx approve`.',
    'Do not read environment files or print secrets.',
    'Stay inside the task worktrees.',
    spec.id === 'review' ? 'End your reply with a line `VERDICT: GO` or `VERDICT: NO-GO`.' : '',
    '',
    custom || builtin || 'Complete this phase using the repository conventions and the task record.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function readBuiltin(name: string): string {
  const file = path.join(packagePrompts(), `${name}.md`);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function packagePrompts(): string {
  return path.join(packageRoot(), 'prompts');
}

interface AgentResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runAgent(cfg: Config, task: string, spec: PhaseConfig, output: string, worktree: string): Promise<AgentResult> {
  const bin = process.env.CX_CLAUDE_BIN || 'claude';
  const prompt = renderPrompt(cfg, task, spec, output);
  mkdirp(path.dirname(output));
  const timeout = Number(process.env.CX_SHIP_TIMEOUT_MS ?? 120_000);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p'], {
      cwd: cfg.workspaceRoot,
      env: {
        ...process.env,
        CX_SHIP_INNER: '1',
        CX_PHASE: spec.id,
        CX_TASK: task,
        CX_WORKSPACE: cfg.workspaceRoot,
        CX_OUTPUT: output,
        CX_WORKTREE: worktree,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new CxError(`agent for ${spec.id} timed out`));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new CxError(`could not start ${bin}: ${err.message}. Install Claude Code or set CX_CLAUDE_BIN to a stub.`));
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function writeAgentLog(cfg: Config, task: string, phase: string, stdout: string, stderr: string): void {
  const folder = cfg.tasks.folders.execute ?? '4-execute';
  const file = path.join(taskDir(cfg, task), folder, 'exec-log', `agent-${phase}.log`);
  mkdirp(path.dirname(file));
  atomicWrite(file, redact(`${stdout}${stderr ? `\n${stderr}` : ''}\n`));
}

function parseVerdict(text: string): 'GO' | 'NO-GO' | undefined {
  const match = /VERDICT:\s*(NO-GO|GO)\b/.exec(text);
  if (!match) return undefined;
  return match[1] as 'GO' | 'NO-GO';
}

export function describePhases(cfg: Config): string {
  return cfg.phases
    .map((phase) => {
      const flag = phase.enabled ? 'on' : 'off';
      const skill = phase.skill ? ` skill=${phase.skill}` : '';
      const gate = phase.gate ? ` gate=${phase.gate}` : '';
      return `${phase.id} ${flag} actor=${phase.actor}${skill}${gate}`;
    })
    .join('\n');
}
