import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import { commandExists } from './util.js';
import { isOrphan, readLease } from './stack.js';

export interface DoctorLine {
  level: 'OK' | 'WARN' | 'FAIL';
  check: string;
  detail: string;
}

export function doctor(startDir: string, home?: string): { ok: boolean; lines: DoctorLine[] } {
  const lines: DoctorLine[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  lines.push(
    nodeMajor >= 20
      ? { level: 'OK', check: 'node', detail: process.versions.node }
      : { level: 'FAIL', check: 'node', detail: `need Node 20+, found ${process.versions.node}` },
  );
  lines.push(
    commandExists('git')
      ? { level: 'OK', check: 'git', detail: 'on PATH' }
      : { level: 'FAIL', check: 'git', detail: 'git is not on PATH' },
  );
  let cfg: Config | undefined;
  try {
    cfg = loadConfig({ startDir, home, honorEnvConfig: true });
    lines.push({
      level: 'OK',
      check: 'config',
      detail: cfg.userConfigPath ? `${cfg.configPath} + ${cfg.userConfigPath}` : cfg.configPath,
    });
  } catch (err) {
    lines.push({ level: 'FAIL', check: 'config', detail: err instanceof Error ? err.message : String(err) });
  }
  if (cfg) addProjectChecks(cfg, lines);
  for (const tool of ['gh', 'claude']) {
    lines.push({
      level: 'OK',
      check: tool,
      detail: commandExists(tool) ? 'on PATH' : 'not on PATH (optional)',
    });
  }
  const ok = lines.every((line) => line.level !== 'FAIL');
  return { ok, lines };
}

function addProjectChecks(cfg: Config, lines: DoctorLine[]): void {
  for (const repo of cfg.workspace.repos) {
    if (!fs.existsSync(repo.absPath)) {
      lines.push({ level: 'WARN', check: `repo ${repo.id}`, detail: `path missing: ${repo.path}` });
    } else {
      lines.push({ level: 'OK', check: `repo ${repo.id}`, detail: repo.path });
    }
    if (!repo.check.trim()) {
      lines.push({
        level: 'WARN',
        check: `check ${repo.id}`,
        detail: 'no check command; cx check will ask you to set one instead of guessing',
      });
    }
  }
  if (cfg.stack.mode === 'none') {
    lines.push({ level: 'OK', check: 'stack', detail: 'mode none' });
  } else if (!commandExists(cfg.stack.docker_bin) && !fs.existsSync(cfg.stack.docker_bin)) {
    lines.push({ level: 'WARN', check: 'docker', detail: `${cfg.stack.docker_bin} is not on PATH` });
  } else {
    lines.push({ level: 'OK', check: 'docker', detail: cfg.stack.docker_bin });
  }
  if (cfg.stack.mode === 'shared') {
    if (!fs.existsSync(cfg.stack.wrapperPath)) {
      lines.push({ level: 'WARN', check: 'stack wrapper', detail: `missing ${cfg.stack.wrapper}` });
    } else {
      lines.push({ level: 'OK', check: 'stack wrapper', detail: cfg.stack.wrapper });
    }
    for (const file of cfg.stack.compose_files) {
      const abs = path.resolve(cfg.workspaceRoot, file);
      if (!fs.existsSync(abs)) lines.push({ level: 'WARN', check: 'compose file', detail: `missing ${file}` });
    }
    if (fs.existsSync(cfg.stack.stateDir)) {
      const mode = fs.statSync(cfg.stack.stateDir).mode & 0o777;
      if (mode & 0o077) {
        lines.push({ level: 'WARN', check: 'stack state', detail: `${cfg.stack.state_dir} mode ${mode.toString(8)} is broader than 700` });
      } else {
        lines.push({ level: 'OK', check: 'stack state', detail: `mode ${mode.toString(8)}` });
      }
    }
    const lease = readLease(cfg);
    if (lease && isOrphan(lease)) {
      lines.push({ level: 'WARN', check: 'lease', detail: `orphaned lease held by ${lease.task}. Run cx stack recover --yes` });
    } else if (lease) {
      lines.push({ level: 'OK', check: 'lease', detail: `held by ${lease.task}` });
    }
  }
  const envFiles = cfg.doctor.env_files.length ? cfg.doctor.env_files : impliedEnvFiles(cfg);
  for (const rel of envFiles) {
    const abs = path.resolve(cfg.workspaceRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const mode = fs.statSync(abs).mode & 0o777;
    if (mode & 0o004) {
      lines.push({
        level: 'WARN',
        check: 'env mode',
        detail: `${rel} is mode ${mode.toString(8)} (world-readable). chmod 600. Contents were not read.`,
      });
    } else {
      lines.push({ level: 'OK', check: 'env mode', detail: `${rel} mode ${mode.toString(8)} (contents not read)` });
    }
  }
}

function impliedEnvFiles(cfg: Config): string[] {
  const files = ['.env'];
  if (cfg.stack.wrapper) files.push(path.join(path.dirname(cfg.stack.wrapper), '.env'));
  return files;
}

export function formatDoctor(lines: DoctorLine[]): string {
  return lines.map((line) => `${line.level.padEnd(4)} ${line.check}: ${line.detail}`).join('\n');
}
