import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, StackService } from './config.js';
import { CxError } from './errors.js';
import { runCommand } from './exec.js';
import { redact } from './redact.js';
import { appendEvent, readState, taskExists, updateState } from './state.js';
import { atomicWrite, isoNow, mkdirp, parseDuration, pidAlive, randomToken, sha256, sleepSync } from './util.js';

interface ServiceSnap {
  name: string;
  image: string;
  tag: string;
  mount: string;
  state: string;
  health: string;
  id: string;
}

interface Baseline {
  project: string;
  compose_files: string[];
  services: Record<string, ServiceSnap>;
  taken_at: string;
}

interface Lease {
  task: string;
  pid: number;
  host: string;
  token_sha256: string;
  started: string;
  ttl_s: number;
  heartbeat: string;
}

interface JournalEntry {
  ts: string;
  op: 'swap' | 'restore';
  svc: string;
  from: string;
  to: string;
}

export interface LeaseResult {
  task: string;
  reused: boolean;
  token?: string;
}

export function stackPaths(cfg: Config): { root: string; lease: string; baseline: string; journal: string } {
  const root = cfg.stack.stateDir;
  return {
    root,
    lease: path.join(root, 'lease'),
    baseline: path.join(root, 'baseline.json'),
    journal: path.join(root, 'journal.ndjson'),
  };
}

export function acquireLease(cfg: Config, task: string, opts: { ttl?: string } = {}): LeaseResult {
  requireShared(cfg);
  requireTask(cfg, task);
  const paths = stackPaths(cfg);
  mkdirp(paths.root, 0o700);
  let created = false;
  try {
    fs.mkdirSync(paths.lease, { mode: 0o700 });
    created = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (!created) {
    const current = readLease(cfg);
    if (!current) throw new CxError('stack lease directory exists without lease.json. Run cx stack recover --yes.');
    if (current.task === task) {
      current.heartbeat = isoNow();
      current.pid = process.pid;
      writeLease(cfg, current);
      return { task, reused: true };
    }
    if (isOrphan(current)) {
      throw new CxError(
        `stack lease is orphaned by ${current.task}. Run \`cx stack recover --yes\` (cx will not take it automatically).`,
      );
    }
    throw new CxError(`stack lease is held by ${current.task} since ${current.started} (heartbeat ${current.heartbeat})`);
  }
  try {
    const baseline = captureBaseline(cfg);
    const token = randomToken();
    const ttlMs = parseDuration(opts.ttl ?? cfg.stack.lease_ttl, 'ttl');
    const lease: Lease = {
      task,
      pid: process.pid,
      host: os.hostname(),
      token_sha256: sha256(token),
      started: isoNow(),
      ttl_s: Math.round(ttlMs / 1000),
      heartbeat: isoNow(),
    };
    atomicWrite(paths.baseline, JSON.stringify(baseline, null, 2), 0o600);
    writeLease(cfg, lease);
    atomicWrite(path.join(paths.root, 'LEASED_BY'), `${task}\n`, 0o600);
    appendEvent(cfg, task, 'lease-acquired', { project: cfg.stack.project });
    return { task, reused: false, token };
  } catch (err) {
    fs.rmSync(paths.lease, { recursive: true, force: true });
    throw err;
  }
}

export function swapService(cfg: Config, task: string, service: string, tag: string, token: string | undefined): void {
  requireShared(cfg);
  const lease = requireHolder(cfg, task);
  requireToken(lease, token);
  const spec = requireService(cfg, service);
  const baseline = readBaseline(cfg);
  const current = baseline.services[service];
  if (!current) throw new CxError(`service ${service} is not in the baseline snapshot`);
  if (spec.kind !== 'mount') {
    const image = `${spec.image}:${tag}`;
    const inspect = runCommand(cfg.stack.docker_bin, ['image', 'inspect', image], { cwd: cfg.workspaceRoot });
    if (inspect.status !== 0) {
      throw new CxError(`image ${image} is not available locally`);
    }
  }
  touchHeartbeat(cfg, lease);
  appendJournal(cfg, { ts: isoNow(), op: 'swap', svc: service, from: valueOf(spec, current), to: tag });
  try {
    callWrapper(cfg, baseline, service, tag);
    waitHealthy(cfg, service);
  } catch (err) {
    try {
      callWrapper(cfg, baseline, service, valueOf(spec, current));
    } catch {
      // the original error is the one to surface; release/recover can finish the restore
    }
    throw err;
  }
  appendEvent(cfg, task, 'stack-swap', { service, tag });
}

export function releaseLease(cfg: Config, task: string): void {
  requireShared(cfg);
  const lease = readLease(cfg);
  if (!lease) return;
  if (lease.task !== task) throw new CxError(`stack lease is held by ${lease.task}, not ${task}`);
  restoreAndMaybeDrop(cfg, lease, false);
}

export function recoverLease(cfg: Config, opts: { yes: boolean; force: boolean }): void {
  requireShared(cfg);
  const lease = readLease(cfg);
  if (!lease) throw new CxError('no stack lease to recover');
  const orphan = isOrphan(lease);
  if (!orphan && !opts.force) {
    throw new CxError(
      `lease held by ${lease.task} (pid ${lease.pid}) is not orphaned. Pass --force --yes to restore anyway.`,
    );
  }
  const journal = readJournal(cfg);
  const summary = [
    `lease: task=${lease.task} pid=${lease.pid} heartbeat=${lease.heartbeat} orphan=${orphan}`,
    ...journal.map((entry) => `journal: ${entry.op} ${entry.svc} ${entry.from} -> ${entry.to}`),
  ].join('\n');
  if (!opts.yes) {
    throw new CxError(`${summary}\nRefusing to recover without --yes.`, 2);
  }
  restoreAndMaybeDrop(cfg, lease, true);
}

export function releaseIfHeld(cfg: Config): { released: boolean; task?: string; error?: string } {
  if (cfg.stack.mode !== 'shared') return { released: false };
  const lease = readLease(cfg);
  if (!lease) return { released: false };
  try {
    restoreAndMaybeDrop(cfg, lease, true);
    return { released: true, task: lease.task };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markBlocked(cfg, lease.task, message);
    return { released: false, task: lease.task, error: message };
  }
}

export function stackUp(cfg: Config, task: string): string[] {
  if (cfg.stack.mode !== 'per-lane') {
    throw new CxError(`cx stack up is for per-lane mode (this workspace is ${cfg.stack.mode})`);
  }
  const args = composeArgs(cfg, task, ['up', '-d']);
  const result = runCommand(cfg.stack.docker_bin, args, { cwd: cfg.workspaceRoot });
  if (result.status !== 0) throw new CxError(`docker compose up failed: ${redact(result.stderr || result.stdout)}`);
  return args;
}

export function stackDown(cfg: Config, task: string): string[] {
  if (cfg.stack.mode !== 'per-lane') {
    throw new CxError(`cx stack down is for per-lane mode (this workspace is ${cfg.stack.mode})`);
  }
  const args = composeArgs(cfg, task, ['down']);
  if (args.includes('-v') || args.includes('--volumes')) {
    throw new CxError('refusing to delete volumes');
  }
  const result = runCommand(cfg.stack.docker_bin, args, { cwd: cfg.workspaceRoot });
  if (result.status !== 0) throw new CxError(`docker compose down failed: ${redact(result.stderr || result.stdout)}`);
  return args;
}

export function stackStatus(cfg: Config): Record<string, unknown> {
  if (cfg.stack.mode === 'none') return { mode: 'none', lease: null };
  if (cfg.stack.mode === 'per-lane') return { mode: 'per-lane', project_pattern: cfg.stack.project_pattern };
  const lease = readLease(cfg);
  let drift: string[] = [];
  let dockerError: string | undefined;
  try {
    if (lease && fs.existsSync(stackPaths(cfg).baseline)) {
      drift = diffBaseline(readBaseline(cfg), captureRunning(cfg));
    }
  } catch (err) {
    dockerError = err instanceof Error ? err.message : String(err);
  }
  return {
    mode: 'shared',
    project: cfg.stack.project,
    lease: lease
      ? {
          task: lease.task,
          pid: lease.pid,
          started: lease.started,
          heartbeat: lease.heartbeat,
          ttl_s: lease.ttl_s,
          orphan: isOrphan(lease),
        }
      : null,
    drift,
    docker_error: dockerError ?? null,
  };
}

export function showBaseline(cfg: Config): Baseline {
  requireShared(cfg);
  if (!fs.existsSync(stackPaths(cfg).baseline)) throw new CxError('no baseline snapshot. Take a lease first.');
  return readBaseline(cfg);
}

function restoreAndMaybeDrop(cfg: Config, lease: Lease, recovering: boolean): void {
  const baseline = readBaseline(cfg);
  const swaps = readJournal(cfg).filter((entry) => entry.op === 'swap');
  for (const entry of [...swaps].reverse()) {
    const spec = cfg.stack.services.find((service) => service.name === entry.svc);
    const snap = baseline.services[entry.svc];
    if (!spec || !snap) continue;
    callWrapper(cfg, baseline, entry.svc, valueOf(spec, snap));
    appendJournal(cfg, { ts: isoNow(), op: 'restore', svc: entry.svc, from: entry.to, to: valueOf(spec, snap) });
  }
  if (cfg.stack.restore.verify_before_release) {
    const drift = diffSwapped(baseline, captureRunning(cfg), swaps.map((entry) => entry.svc));
    if (drift.length > 0) {
      markBlocked(cfg, lease.task, `restore mismatch: ${drift.join('; ')}`);
      throw new CxError(`restore mismatch, lease kept: ${drift.join('; ')}`);
    }
  }
  const paths = stackPaths(cfg);
  const history = path.join(paths.root, 'history');
  mkdirp(history, 0o700);
  const stamp = `${isoNow().replace(/[:.]/g, '-')}-${lease.task}`;
  if (fs.existsSync(paths.baseline)) fs.renameSync(paths.baseline, path.join(history, `${stamp}-baseline.json`));
  if (fs.existsSync(paths.journal)) fs.renameSync(paths.journal, path.join(history, `${stamp}-journal.ndjson`));
  fs.rmSync(paths.lease, { recursive: true, force: true });
  fs.rmSync(path.join(paths.root, 'LEASED_BY'), { force: true });
  if (taskExists(cfg, lease.task)) {
    appendEvent(cfg, lease.task, recovering ? 'lease-recovered' : 'lease-released', {});
  }
}

function markBlocked(cfg: Config, task: string, reason: string): void {
  if (!taskExists(cfg, task)) return;
  updateState(cfg, task, (state) => {
    state.resume_phase = state.phase === 'blocked' ? state.resume_phase : state.phase;
    state.phase = 'blocked';
    state.summary = `BLOCKED: ${reason}`;
  });
}

function captureBaseline(cfg: Config): Baseline {
  const services: Record<string, ServiceSnap> = {};
  for (const snap of captureRunning(cfg)) services[snap.name] = snap;
  return {
    project: cfg.stack.project,
    compose_files: cfg.stack.compose_files,
    services,
    taken_at: isoNow(),
  };
}

function captureRunning(cfg: Config): ServiceSnap[] {
  const result = runCommand(
    cfg.stack.docker_bin,
    ['compose', '-p', cfg.stack.project, 'ps', '--format', 'json'],
    { cwd: cfg.workspaceRoot },
  );
  if (result.status !== 0) {
    throw new CxError(`docker compose ps failed: ${redact(result.stderr || result.stdout).trim()}`);
  }
  return parsePs(result.stdout).map((row) => toSnap(cfg, row));
}

function parsePs(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as Record<string, unknown>[];
  return trimmed
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toSnap(cfg: Config, row: Record<string, unknown>): ServiceSnap {
  const name = String(row.Service ?? row.Name ?? row.service ?? '');
  const image = String(row.Image ?? row.image ?? '');
  const spec = cfg.stack.services.find((service) => service.name === name);
  const mount = String(row.Mount ?? row.mount ?? '');
  const tag = spec?.kind === 'mount' ? mount : tagFromImage(image);
  return {
    name,
    image,
    tag,
    mount,
    state: String(row.State ?? row.state ?? ''),
    health: String(row.Health ?? row.health ?? ''),
    id: String(row.ID ?? row.Id ?? row.id ?? ''),
  };
}

function tagFromImage(image: string): string {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon > slash) return image.slice(colon + 1);
  return 'latest';
}

function callWrapper(cfg: Config, baseline: Baseline, service: string, value: string): void {
  if (!fs.existsSync(cfg.stack.wrapperPath)) {
    throw new CxError(`stack wrapper not found: ${cfg.stack.wrapper}`);
  }
  const spec = requireService(cfg, service);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cfg.stack.restore.export_all_baseline_tags) {
    for (const item of cfg.stack.services) {
      const snap = baseline.services[item.name];
      if (!snap) continue;
      env[item.tag_var] = valueOf(item, snap);
    }
  }
  env[spec.tag_var] = value;
  const args = ['up', '-d', '--no-deps', service];
  if (cfg.stack.restore.require_no_deps && !args.includes('--no-deps')) {
    throw new CxError('refusing a wrapper invocation without --no-deps');
  }
  const result = runCommand(cfg.stack.wrapperPath, args, { cwd: cfg.workspaceRoot, env });
  if (result.status !== 0) {
    throw new CxError(`wrapper ${path.basename(cfg.stack.wrapperPath)} failed: ${redact(result.stderr || result.stdout).trim()}`);
  }
}

function waitHealthy(cfg: Config, service: string): void {
  const timeout = parseDuration(cfg.stack.health_timeout, 'stack.health_timeout');
  const started = Date.now();
  for (;;) {
    const snap = captureRunning(cfg).find((item) => item.name === service);
    if (snap && healthy(snap)) return;
    if (Date.now() - started >= timeout) {
      throw new CxError(`service ${service} did not become healthy within ${cfg.stack.health_timeout}`);
    }
    sleepSync(Math.min(200, Math.max(timeout - (Date.now() - started), 20)));
  }
}

function healthy(snap: ServiceSnap): boolean {
  if (snap.health === 'healthy' || snap.health === 'none') return true;
  if (!snap.health && (snap.state === 'running' || snap.state === 'Running')) return true;
  return false;
}

function diffBaseline(baseline: Baseline, running: ServiceSnap[]): string[] {
  return diffSnaps(baseline, running, Object.keys(baseline.services));
}

function diffSwapped(baseline: Baseline, running: ServiceSnap[], names: string[]): string[] {
  const unique = [...new Set(names)];
  return diffSnaps(baseline, running, unique);
}

function diffSnaps(baseline: Baseline, running: ServiceSnap[], names: string[]): string[] {
  const drift: string[] = [];
  for (const name of names) {
    const before = baseline.services[name];
    const after = running.find((item) => item.name === name);
    if (!before || !after) {
      drift.push(`${name} missing`);
      continue;
    }
    if (before.image !== after.image) drift.push(`${name} image ${after.image} != ${before.image}`);
    if ((before.mount || '') !== (after.mount || '')) drift.push(`${name} mount changed`);
  }
  return drift;
}

function valueOf(spec: StackService, snap: ServiceSnap): string {
  return spec.kind === 'mount' ? snap.mount : snap.tag;
}

function composeArgs(cfg: Config, task: string, rest: string[]): string[] {
  const project = cfg.stack.project_pattern.replaceAll('{task}', task);
  const file = path.resolve(cfg.workspaceRoot, cfg.stack.compose_file);
  return ['compose', '-p', project, '-f', file, ...rest];
}

function requireShared(cfg: Config): void {
  if (cfg.stack.mode !== 'shared') {
    throw new CxError(`this command needs stack.mode shared (current: ${cfg.stack.mode})`);
  }
}

function requireTask(cfg: Config, task: string): void {
  if (!taskExists(cfg, task)) throw new CxError(`task ${task} does not exist`);
}

function requireHolder(cfg: Config, task: string): Lease {
  const lease = readLease(cfg);
  if (!lease) throw new CxError('no stack lease. Run cx stack lease first.');
  if (lease.task !== task) throw new CxError(`stack lease is held by ${lease.task}, not ${task}`);
  return lease;
}

function requireToken(lease: Lease, token: string | undefined): void {
  if (!token) throw new CxError('pass the lease token with --token or CX_LEASE_TOKEN');
  if (sha256(token) !== lease.token_sha256) throw new CxError('lease token does not match');
}

function requireService(cfg: Config, name: string): StackService {
  const spec = cfg.stack.services.find((service) => service.name === name);
  if (!spec) throw new CxError(`unknown stack service ${name}`);
  return spec;
}

export function readLease(cfg: Config): Lease | undefined {
  const file = path.join(stackPaths(cfg).lease, 'lease.json');
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Lease;
}

function writeLease(cfg: Config, lease: Lease): void {
  atomicWrite(path.join(stackPaths(cfg).lease, 'lease.json'), JSON.stringify(lease, null, 2), 0o600);
}

function readBaseline(cfg: Config): Baseline {
  return JSON.parse(fs.readFileSync(stackPaths(cfg).baseline, 'utf8')) as Baseline;
}

function readJournal(cfg: Config): JournalEntry[] {
  const file = stackPaths(cfg).journal;
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JournalEntry);
}

function appendJournal(cfg: Config, entry: JournalEntry): void {
  fs.appendFileSync(stackPaths(cfg).journal, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function touchHeartbeat(cfg: Config, lease: Lease): void {
  lease.heartbeat = isoNow();
  lease.pid = process.pid;
  writeLease(cfg, lease);
}

export function isOrphan(lease: Lease): boolean {
  const heartbeat = Date.parse(lease.heartbeat);
  const expired = Number.isFinite(heartbeat) && Date.now() - heartbeat > lease.ttl_s * 1000;
  return expired && !pidAlive(lease.pid);
}

export function readStateSafe(cfg: Config, task: string): ReturnType<typeof readState> | undefined {
  try {
    return readState(cfg, task);
  } catch {
    return undefined;
  }
}
