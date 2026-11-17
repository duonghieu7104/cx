import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { CxError } from './errors.js';
import { mkdirp, pidAlive, sleepSync } from './util.js';

interface Ticket {
  pid: number;
  task: string;
  kind: string;
  at: number;
}

export interface QueueSnapshot {
  cooldown_ms: number;
  running: { slot: string; task?: string; kind?: string; pid?: number }[];
  waiting: { ticket: string; task?: string; kind?: string }[];
  last_finished: number | null;
}

export function withQueue<T>(cfg: Config, task: string, kind: string, job: () => T): T {
  const dir = cfg.queue.absDir;
  const tickets = path.join(dir, 'tickets');
  mkdirp(tickets);
  mkdirp(path.join(dir, 'running'));
  const name = `${String(Date.now()).padStart(15, '0')}-${process.pid}-${safe(task)}-${safe(kind)}`;
  const ticketPath = path.join(tickets, name);
  const body: Ticket = { pid: process.pid, task, kind, at: Date.now() };
  fs.writeFileSync(ticketPath, JSON.stringify(body));
  const slots = cfg.queue.mode === 'parallel' ? cfg.queue.parallelism : 1;
  const deadline = Date.now() + Math.max(cfg.queue.cooldownMs + 30_000, 60_000);
  try {
    for (;;) {
      if (Date.now() > deadline) throw new CxError(`queue wait timed out for ${task} ${kind}`);
      reapTickets(tickets);
      reapSlots(dir, slots);
      const waiting = fs.readdirSync(tickets).filter((entry) => !entry.startsWith('.')).sort();
      if (waiting[0] !== name) {
        sleepSync(40);
        continue;
      }
      const slot = trySlot(dir, slots);
      if (!slot) {
        sleepSync(40);
        continue;
      }
      const last = readLast(dir);
      const wait = cfg.queue.mode === 'serial' ? cfg.queue.cooldownMs - (Date.now() - last) : 0;
      if (wait > 0) {
        fs.rmSync(slot, { recursive: true, force: true });
        sleepSync(Math.min(wait, 100));
        continue;
      }
      fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, task, kind, at: Date.now() }));
      try {
        return job();
      } finally {
        fs.writeFileSync(path.join(dir, 'last_finished'), String(Date.now()));
        fs.rmSync(slot, { recursive: true, force: true });
        fs.rmSync(ticketPath, { force: true });
      }
    }
  } catch (err) {
    fs.rmSync(ticketPath, { force: true });
    throw err;
  }
}

export function queueSnapshot(cfg: Config): QueueSnapshot {
  const dir = cfg.queue.absDir;
  if (!fs.existsSync(dir)) {
    return { cooldown_ms: cfg.queue.cooldownMs, running: [], waiting: [], last_finished: null };
  }
  const tickets = path.join(dir, 'tickets');
  const waiting = fs.existsSync(tickets)
    ? fs.readdirSync(tickets).filter((entry) => !entry.startsWith('.')).sort().map((ticket) => {
        const data = readTicket(path.join(tickets, ticket));
        return { ticket, task: data?.task, kind: data?.kind };
      })
    : [];
  const runningDir = path.join(dir, 'running');
  const running = fs.existsSync(runningDir)
    ? fs.readdirSync(runningDir).map((slot) => {
        const owner = readTicket(path.join(runningDir, slot, 'owner.json'));
        return { slot, task: owner?.task, kind: owner?.kind, pid: owner?.pid };
      })
    : [];
  const last = fs.existsSync(path.join(dir, 'last_finished')) ? readLast(dir) : null;
  return { cooldown_ms: cfg.queue.cooldownMs, running, waiting, last_finished: last || null };
}

function trySlot(dir: string, slots: number): string | undefined {
  for (let i = 0; i < slots; i++) {
    const slot = path.join(dir, 'running', String(i));
    try {
      fs.mkdirSync(slot);
      return slot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  return undefined;
}

function reapTickets(tickets: string): void {
  if (!fs.existsSync(tickets)) return;
  for (const name of fs.readdirSync(tickets)) {
    const file = path.join(tickets, name);
    const data = readTicket(file);
    if (data && !pidAlive(data.pid) && Date.now() - data.at > 1000) fs.rmSync(file, { force: true });
  }
}

function reapSlots(dir: string, slots: number): void {
  for (let i = 0; i < slots; i++) {
    const slot = path.join(dir, 'running', String(i));
    if (!fs.existsSync(slot)) continue;
    const data = readTicket(path.join(slot, 'owner.json'));
    if (!data) {
      try {
        const st = fs.statSync(slot);
        if (Date.now() - st.mtimeMs > 30_000) fs.rmSync(slot, { recursive: true, force: true });
      } catch {
        // slot disappeared
      }
      continue;
    }
    if (!pidAlive(data.pid) && Date.now() - data.at > 1000) fs.rmSync(slot, { recursive: true, force: true });
  }
}

function readTicket(file: string): Ticket | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Ticket;
  } catch {
    return undefined;
  }
}

function readLast(dir: string): number {
  try {
    return Number(fs.readFileSync(path.join(dir, 'last_finished'), 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}
