import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CxError } from './errors.js';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

export function atomicWrite(file: string, data: string | Buffer, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

export function mkdirp(dir: string, mode = 0o755): void {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // chmod can fail on some mounts; the directory still exists.
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

interface LockOwner {
  pid: number;
  at: number;
}

export function withLock<T>(lockDir: string, fn: () => T, timeoutMs = 15_000): T {
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockIsStale(lockDir)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new CxError(`timed out waiting for lock ${lockDir}`);
      }
      sleepSync(30);
    }
  }
  try {
    const owner: LockOwner = { pid: process.pid, at: Date.now() };
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner));
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function lockIsStale(lockDir: string): boolean {
  const ownerPath = path.join(lockDir, 'owner.json');
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as LockOwner;
    if (!pidAlive(owner.pid) && Date.now() - owner.at > 500) return true;
    return false;
  } catch {
    try {
      const st = fs.statSync(lockDir);
      return Date.now() - st.mtimeMs > 30_000;
    } catch {
      return false;
    }
  }
}

export function parseDuration(value: string | number, what: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new CxError(`${what} must be a non-negative duration`);
    }
    return Math.round(value * 1000);
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (!match) {
    throw new CxError(`${what} must look like 500ms, 60s, 45m, or 1h (got ${JSON.stringify(value)})`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const scale = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.round(amount * scale);
}

export function assertSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new CxError(`task name must be kebab-case (example: stream-fix), got ${JSON.stringify(slug)}`);
  }
}

export function formatPattern(pattern: string, vars: Record<string, string>): string {
  return pattern.replace(/\{([a-z_]+)\}/g, (raw, key: string) => {
    if (!(key in vars)) throw new CxError(`unknown placeholder ${raw} in pattern ${pattern}`);
    return vars[key];
  });
}

export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if ('+?^${}()|[]\\.'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

export function matchGlob(glob: string, value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  const pattern = glob.replaceAll('\\', '/');
  if (globToRegExp(pattern).test(normalized)) return true;
  const base = normalized.split('/').pop() ?? normalized;
  if (!pattern.includes('/')) return globToRegExp(pattern).test(base);
  return false;
}

export function matchAnyGlob(globs: string[], value: string): boolean {
  return globs.some((glob) => matchGlob(glob, value));
}

export function compileRegex(pattern: string, what: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CxError(`${what} is not a valid regular expression (${message})`);
  }
}

export function commandExists(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function localDateLabel(date = new Date()): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
