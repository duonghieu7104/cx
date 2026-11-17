import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { approvalState } from './approve.js';
import { configHome, loadConfig, type Config, type PhaseConfig } from './config.js';
import { git } from './git.js';
import { queueSnapshot } from './queue.js';
import { redact } from './redact.js';
import { eventsPath, laneAbs, listTaskIds, readState, taskDir, type TaskState } from './state.js';
import { stackBoard } from './stack.js';
import { atomicWrite, mkdirp, packageRoot } from './util.js';

const COOKIE = 'cx_dash';
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export interface DashHandle {
  port: number;
  address: string;
  token: string;
  close: () => Promise<void>;
}

export function startDashboard(opts: { port?: number; cwd?: string; home?: string; cfg?: Config }): Promise<DashHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const home = configHome(opts.home);
  if (!home) throw new Error('HOME is unset; the dashboard token needs ~/.config/cx');
  const cfg = opts.cfg ?? loadConfig({ startDir: cwd, home });
  const token = loadToken(home);
  const index = fs.readFileSync(path.join(packageRoot(), 'dashboard', 'public', 'index.html'));
  const port = opts.port ?? 8377;

  const server = createServer((req, res) => {
    try {
      handle(req, res, { cfg, token, index, port: boundPort(server) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'error';
      send(res, 500, 'text/plain; charset=utf-8', redact(message));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: bound,
        address: '127.0.0.1',
        token,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

function boundPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { cfg: Config; token: string; index: Buffer; port: number },
): void {
  if (!hostOk(req, ctx.port)) {
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden host');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    send(res, 405, 'text/plain; charset=utf-8', 'read-only');
    return;
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`);
  if (looksSensitive(url.pathname)) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  if (url.pathname === '/' && url.searchParams.has('t')) {
    const presented = url.searchParams.get('t') ?? '';
    if (!same(presented, ctx.token)) {
      send(res, 401, 'text/plain; charset=utf-8', 'unauthorized');
      return;
    }
    res.statusCode = 302;
    res.setHeader('location', '/');
    res.setHeader('set-cookie', cookie(ctx.token));
    res.setHeader('cache-control', 'no-store');
    res.end();
    return;
  }
  if (!authorized(req, ctx.token)) {
    send(res, 401, 'text/html; charset=utf-8', lockedPage());
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    send(res, 200, 'text/html; charset=utf-8', ctx.index);
    return;
  }
  if (url.pathname === '/api/snapshot') {
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot(ctx.cfg)));
    return;
  }
  if (url.pathname.startsWith('/proof/')) {
    serveProof(ctx.cfg, url.pathname.slice('/proof/'.length), res);
    return;
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

function hostOk(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  return host === `127.0.0.1:${port}`;
}

function looksSensitive(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return lower.includes('cred') || lower.includes('.env') || lower.endsWith('/token') || lower.includes('secret');
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.cookie ?? '';
  const parts = header.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE && same(decodeURIComponent(rest.join('=')), token)) return true;
  }
  return false;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function cookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function loadToken(home: string): string {
  const dir = path.join(home, '.config', 'cx');
  mkdirp(dir, 0o700);
  const file = path.join(dir, 'dash.token');
  if (fs.existsSync(file)) {
    fs.chmodSync(file, 0o600);
    return fs.readFileSync(file, 'utf8').trim();
  }
  const token = randomBytes(32).toString('hex');
  atomicWrite(file, `${token}\n`, 0o600);
  return token;
}

export function snapshot(cfg: Config): unknown {
  const phases = cfg.phases.filter((phase) => phase.enabled).map(publicPhase);
  const tasks = listTaskIds(cfg).map((id) => taskView(cfg, id));
  const queue = queueSnapshot(cfg);
  const remaining =
    queue.last_finished === null ? 0 : Math.max(0, queue.cooldown_ms - (Date.now() - queue.last_finished));
  return {
    read_only: true,
    project: path.basename(cfg.workspaceRoot),
    phases,
    tasks,
    stack: stackBoard(cfg),
    queue: { ...queue, cooldown_remaining_ms: remaining },
  };
}

function publicPhase(phase: PhaseConfig): unknown {
  return {
    id: phase.id,
    actor: phase.actor,
    gate: phase.gate ?? null,
    command: phase.command ?? null,
  };
}

function taskView(cfg: Config, id: string): unknown {
  const state = readState(cfg, id);
  const events = readEvents(cfg, id);
  const last = events.length ? String(events[events.length - 1].ts ?? '') : state.updated;
  const gates = cfg.gates.require.map((what) => {
    try {
      const status = approvalState(cfg, id, what);
      const record = [...state.approvals].reverse().find((item) => item.what === what);
      return { what, ok: status.ok, reason: status.reason, by: record?.by ?? null, ts: record?.ts ?? null };
    } catch (err) {
      return { what, ok: false, reason: err instanceof Error ? err.message : 'unavailable', by: null, ts: null };
    }
  });
  return {
    task: state.task,
    title: state.title,
    phase: state.phase,
    summary: redact(state.summary),
    updated: state.updated,
    liveness: liveness(last),
    review: state.review,
    lanes: state.lanes.map((lane) => laneView(cfg, lane)),
    gates,
    prs: state.prs,
    events: events.slice(-40),
    checks: checkTails(cfg, state),
    excerpts: excerpts(cfg, id),
    proofs: proofs(cfg, id),
  };
}

function laneView(cfg: Config, lane: TaskState['lanes'][number]): unknown {
  const abs = laneAbs(cfg, lane);
  let dirty = false;
  let head = '';
  if (fs.existsSync(abs)) {
    const status = git(abs, ['status', '--porcelain']);
    dirty = status.status === 0 && status.stdout.trim().length > 0;
    const rev = git(abs, ['rev-parse', '--short=7', 'HEAD']);
    head = rev.status === 0 ? rev.stdout.trim() : '';
  }
  return {
    repo: lane.repo,
    branch: lane.branch,
    base: lane.base,
    worktree: lane.worktree,
    services: lane.services,
    status: lane.status,
    dirty,
    head,
  };
}

function readEvents(cfg: Config, task: string): { ts?: string; actor?: string; event?: string; data?: unknown }[] {
  const file = eventsPath(cfg, task);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(redact(line)) as { ts?: string; actor?: string; event?: string; data?: unknown };
      } catch {
        return { event: 'unparsed' };
      }
    });
}

function liveness(ts: string): 'live' | 'recent' | 'stale' {
  const age = Date.now() - Date.parse(ts);
  if (!Number.isFinite(age)) return 'stale';
  if (age < 2 * 60 * 1000) return 'live';
  if (age < 15 * 60 * 1000) return 'recent';
  return 'stale';
}

function checkTails(cfg: Config, state: TaskState): { repo: string; file: string; tail: string }[] {
  const folder = cfg.tasks.folders.execute ?? '4-execute';
  const dir = path.join(taskDir(cfg, state.task), folder, 'exec-log');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('checks-') && name.endsWith('.log'))
    .map((name) => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const tail = redact(text)
        .split('\n')
        .filter((line) => !line.includes('npm notice'))
        .slice(-30)
        .join('\n');
      return { repo: name.replace(/^checks-/, '').replace(/\.log$/, ''), file: name, tail };
    });
}

function excerpts(cfg: Config, task: string): { plan: string; review: string; report: string } {
  const dir = taskDir(cfg, task);
  return {
    plan: clip(readIf(path.join(dir, cfg.tasks.folders.plan ?? '2-plan', 'PLAN.md'))),
    review: clip(newest(path.join(dir, cfg.tasks.folders.review ?? '4-execute'), /^REVIEW-\d+\.md$/)),
    report: clip(readIf(path.join(dir, cfg.tasks.folders.test_local ?? '5-test', 'REPORT.md'))),
  };
}

function proofs(cfg: Config, task: string): { file: string; url: string }[] {
  const root = proofRoot(cfg, task);
  if (!fs.existsSync(root)) return [];
  const found: { file: string; url: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (IMAGE.test(entry.name)) {
        const rel = path.relative(root, abs).replaceAll('\\', '/');
        found.push({ file: rel, url: `/proof/${encodeURIComponent(task)}/${rel.split('/').map(encodeURIComponent).join('/')}` });
      }
    }
  };
  walk(root);
  return found;
}

function proofRoot(cfg: Config, task: string): string {
  return path.join(taskDir(cfg, task), cfg.tasks.folders.test_local ?? '5-test');
}

function serveProof(cfg: Config, pathname: string, res: ServerResponse): void {
  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const task = parts.shift() ?? '';
  const rel = parts.join('/');
  if (!/^[a-z0-9-]+$/.test(task) || !rel || rel.includes('\0')) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  const root = proofRoot(cfg, task);
  if (!fs.existsSync(root)) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  const target = path.resolve(root, rel);
  let realRoot = '';
  let real = '';
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(target);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  if (!IMAGE.test(real)) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
    return;
  }
  const type = real.endsWith('.png') ? 'image/png' : real.endsWith('.webp') ? 'image/webp' : real.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
  send(res, 200, type, fs.readFileSync(real));
}

function readIf(file: string): string {
  if (!fs.existsSync(file)) return '';
  return redact(fs.readFileSync(file, 'utf8'));
}

function newest(dir: string, pattern: RegExp): string {
  if (!fs.existsSync(dir)) return '';
  const names = fs.readdirSync(dir).filter((name) => pattern.test(name)).sort();
  if (names.length === 0) return '';
  return readIf(path.join(dir, names[names.length - 1]));
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 700 ? `${trimmed.slice(0, 700)}…` : trimmed;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}

function lockedPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>cx</title><body style="font:16px/1.5 ui-sans-serif,system-ui;background:#10140f;color:#edf2e8;display:grid;place-items:center;height:100vh"><p>Open the link printed by <code>cx dash</code>. This page is local and read-only.</p></body>`;
}
