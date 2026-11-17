import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CxError } from './errors.js';
import { redact } from './redact.js';
import { atomicWrite, mkdirp } from './util.js';

export interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  file: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): ShellResult {
  const result = spawnSync(file, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runShell(command: string, cwd: string, env?: NodeJS.ProcessEnv): ShellResult {
  return runCommand('sh', ['-c', command], { cwd, env });
}

export function writeLog(file: string, result: ShellResult): void {
  mkdirp(path.dirname(file));
  const body = redact(`$ (exit ${result.status})\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\n`);
  atomicWrite(file, body);
}

export function shellError(command: string, result: ShellResult): CxError {
  const detail = redact((result.stderr || result.stdout).trim()).slice(0, 2000);
  return new CxError(`command failed (${result.status}): ${command}${detail ? `\n${detail}` : ''}`);
}

export function ensureExecutable(file: string): void {
  if (!fs.existsSync(file)) throw new CxError(`command not found: ${file}`);
}
