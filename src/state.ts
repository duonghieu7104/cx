import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { Config } from './config.js';
import { CxError } from './errors.js';
import { atomicWrite, isoNow, localDateLabel, mkdirp, withLock } from './util.js';

export interface LaneState {
  repo: string;
  worktree: string;
  branch: string;
  base: string;
  services: string[];
  status: string;
}

export interface HeadBinding {
  repo: string;
  head: string;
  content: string;
}

export interface Approval {
  what: string;
  by: 'human' | 'auto';
  ts: string;
  note: string;
  heads: HeadBinding[];
}

export interface PullRequestRecord {
  repo: string;
  url: string;
  base: string;
}

export interface TaskState {
  task: string;
  title: string;
  phase: string;
  updated: string;
  summary: string;
  lanes: LaneState[];
  review: { round: number; verdict: string | null };
  approvals: Approval[];
  prs: PullRequestRecord[];
  resume_phase?: string;
}

const STATE_BEGIN = '<!-- cx:state:begin -->';
const STATE_END = '<!-- cx:state:end -->';

export function taskDir(cfg: Config, task: string): string {
  return path.join(cfg.tasks.absRoot, task);
}

export function statePath(cfg: Config, task: string): string {
  return path.join(taskDir(cfg, task), cfg.tasks.state_file);
}

export function eventsPath(cfg: Config, task: string): string {
  return path.join(taskDir(cfg, task), cfg.tasks.events_file);
}

export function lockPath(cfg: Config, task: string): string {
  return path.join(taskDir(cfg, task), '.cx.lock');
}

export function listTaskIds(cfg: Config): string[] {
  if (!fs.existsSync(cfg.tasks.absRoot)) return [];
  return fs
    .readdirSync(cfg.tasks.absRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(cfg.tasks.absRoot, name, cfg.tasks.state_file)))
    .sort();
}

export function taskExists(cfg: Config, task: string): boolean {
  return fs.existsSync(statePath(cfg, task));
}

export function createTaskFiles(cfg: Config, state: TaskState): void {
  const dir = taskDir(cfg, state.task);
  mkdirp(dir);
  for (const folder of Object.values(cfg.tasks.folders)) {
    if (!folder || folder === '.') continue;
    mkdirp(path.join(dir, folder));
  }
  mkdirp(path.dirname(eventsPath(cfg, state.task)));
  const body = renderTaskDoc(cfg, state, '## Notes\n\n');
  atomicWrite(statePath(cfg, state.task), body);
}

export function readState(cfg: Config, task: string): TaskState {
  const file = statePath(cfg, task);
  if (!fs.existsSync(file)) throw new CxError(`task ${task} does not exist (${file})`);
  const text = fs.readFileSync(file, 'utf8');
  const raw = extractState(text, file);
  return normalizeState(raw, task);
}

export function updateState(cfg: Config, task: string, mutate: (state: TaskState) => void): TaskState {
  return withLock(lockPath(cfg, task), () => {
    const file = statePath(cfg, task);
    const text = fs.readFileSync(file, 'utf8');
    const state = normalizeState(extractState(text, file), task);
    const before = state.phase;
    mutate(state);
    state.updated = isoNow();
    atomicWrite(file, replaceState(text, state));
    if (state.phase !== before) {
      appendEvent(cfg, task, 'phase', { from: before, to: state.phase, summary: state.summary });
    }
    return state;
  });
}

export function appendEvent(cfg: Config, task: string, event: string, data: unknown): void {
  const file = eventsPath(cfg, task);
  mkdirp(path.dirname(file));
  fs.appendFileSync(
    file,
    `${JSON.stringify({ ts: isoNow(), actor: 'cx', event, data })}\n`,
  );
}

export function laneAbs(cfg: Config, lane: LaneState): string {
  return path.isAbsolute(lane.worktree) ? lane.worktree : path.resolve(cfg.workspaceRoot, lane.worktree);
}

export function nextEnabledPhase(cfg: Config, current: string): string | undefined {
  const phases = cfg.phases.filter((phase) => phase.enabled);
  const index = phases.findIndex((phase) => phase.id === current);
  if (index < 0) return undefined;
  return phases[index + 1]?.id;
}

export function applyReviewVerdict(
  state: TaskState,
  verdict: 'GO' | 'NO-GO',
  maxRounds: number,
  retryPhase: string,
): void {
  if (verdict === 'GO') {
    state.review.verdict = 'GO';
    state.summary = `review GO (round ${state.review.round + 1})`;
    return;
  }
  state.review.round += 1;
  state.review.verdict = 'NO-GO';
  if (state.review.round >= maxRounds) {
    state.phase = 'blocked';
    state.summary = `review NO-GO ${state.review.round} time(s); blocked for a human`;
    return;
  }
  state.phase = retryPhase;
  state.summary = `review NO-GO; back to ${retryPhase} (round ${state.review.round}/${maxRounds})`;
}

function extractState(text: string, file: string): unknown {
  if (file.endsWith('.md')) {
    const start = text.indexOf(STATE_BEGIN);
    const end = text.indexOf(STATE_END);
    if (start < 0 || end < start) throw new CxError(`state markers missing in ${file}`);
    const block = text.slice(start + STATE_BEGIN.length, end);
    const fenced = /```ya?ml\n([\s\S]*?)```/.exec(block);
    const yamlText = fenced ? fenced[1] : block;
    return parse(yamlText);
  }
  return parse(text);
}

function replaceState(text: string, state: TaskState): string {
  const block = renderStateBlock(state);
  const status = statusLine(state);
  let next = text;
  if (/^\*\*Status \(.*?\):\*\*.*$/m.test(next)) {
    next = next.replace(/^\*\*Status \(.*?\):\*\*.*$/m, status);
  }
  const start = next.indexOf(STATE_BEGIN);
  const end = next.indexOf(STATE_END);
  if (start >= 0 && end > start) {
    return next.slice(0, start) + block + next.slice(end + STATE_END.length);
  }
  return `${next.trimEnd()}\n\n${block}\n`;
}

function renderTaskDoc(cfg: Config, state: TaskState, tail: string): string {
  const folders = Object.entries(cfg.tasks.folders)
    .filter(([, folder]) => folder && folder !== '.')
    .map(([phase, folder]) => `- \`${folder}/\` — ${phase}`)
    .join('\n');
  return `# ${state.title}\n\n${statusLine(state)}\n\n${renderStateBlock(state)}\n\n## Folder map\n\n${folders}\n\n${tail}`;
}

function statusLine(state: TaskState): string {
  const summary = state.summary ? ` — ${state.summary}` : '';
  return `**Status (${localDateLabel()}):** ${state.phase}${summary}`;
}

function renderStateBlock(state: TaskState): string {
  const yaml = stringify(toYaml(state)).trimEnd();
  return `${STATE_BEGIN}\n\`\`\`yaml\n${yaml}\n\`\`\`\n${STATE_END}`;
}

function toYaml(state: TaskState): Record<string, unknown> {
  return {
    task: state.task,
    title: state.title,
    phase: state.phase,
    updated: state.updated,
    summary: state.summary,
    lanes: state.lanes,
    review: state.review,
    approvals: state.approvals,
    prs: state.prs,
    ...(state.resume_phase ? { resume_phase: state.resume_phase } : {}),
  };
}

function normalizeState(raw: unknown, task: string): TaskState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CxError(`state for ${task} is not a mapping`);
  }
  const record = raw as Record<string, unknown>;
  const review = (record.review ?? {}) as { round?: number; verdict?: string | null };
  return {
    task: String(record.task ?? task),
    title: String(record.title ?? task),
    phase: String(record.phase ?? 'intake'),
    updated: String(record.updated ?? isoNow()),
    summary: String(record.summary ?? ''),
    lanes: Array.isArray(record.lanes) ? (record.lanes as LaneState[]) : [],
    review: { round: Number(review.round ?? 0), verdict: review.verdict ?? null },
    approvals: Array.isArray(record.approvals) ? (record.approvals as Approval[]) : [],
    prs: Array.isArray(record.prs) ? (record.prs as PullRequestRecord[]) : [],
    resume_phase: record.resume_phase ? String(record.resume_phase) : undefined,
  };
}

export function blankState(task: string, title: string): TaskState {
  return {
    task,
    title,
    phase: 'intake',
    updated: isoNow(),
    summary: 'task created',
    lanes: [],
    review: { round: 0, verdict: null },
    approvals: [],
    prs: [],
  };
}
