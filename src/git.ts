import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CxError } from './errors.js';
import { sha256 } from './util.js';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').replace(/\n$/, ''),
    stderr: result.stderr ?? '',
  };
}

export function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CxError(`git ${args.join(' ')} failed in ${cwd}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

export function hasRemote(cwd: string, name = 'origin'): boolean {
  return gitOk(cwd, ['remote'])
    .split('\n')
    .filter(Boolean)
    .includes(name);
}

export function refExists(cwd: string, ref: string): boolean {
  return git(cwd, ['rev-parse', '--verify', '--quiet', ref]).status === 0;
}

export function isDirty(cwd: string): boolean {
  return gitOk(cwd, ['status', '--porcelain']).length > 0;
}

/** A branch with no upstream counts as not pushed. */
export function isUnpushed(cwd: string): boolean {
  const upstream = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream.status !== 0) return true;
  const ahead = gitOk(cwd, ['rev-list', '--count', '@{upstream}..HEAD']);
  return Number(ahead) > 0;
}

export function worktreeList(cwd: string): string[] {
  const text = gitOk(cwd, ['worktree', 'list', '--porcelain']);
  return text
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

export function fingerprint(cwd: string): { head: string; content: string } {
  const head = gitOk(cwd, ['rev-parse', 'HEAD']);
  const porcelain = gitOk(cwd, ['status', '--porcelain']);
  const diff = gitOk(cwd, ['diff', 'HEAD']);
  const staged = gitOk(cwd, ['diff', '--cached']);
  const untracked = gitOk(cwd, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .map((file) => {
      const abs = path.join(cwd, file);
      try {
        return `${file}:${sha256(fs.readFileSync(abs))}`;
      } catch {
        return `${file}:missing`;
      }
    });
  return { head, content: sha256(`${head}\n${porcelain}\n${diff}\n${staged}\n${untracked.join('\n')}`) };
}

export function shortSha(cwd: string): { sha: string; dirty: boolean } {
  const sha = gitOk(cwd, ['rev-parse', '--short=7', 'HEAD']);
  return { sha, dirty: isDirty(cwd) };
}

export function findGitRoot(start: string): string | undefined {
  const result = git(start, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return undefined;
  return result.stdout;
}

export function currentBranch(cwd: string): string {
  const result = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (result.status !== 0) return '';
  return result.stdout;
}

export function localBranches(cwd: string): string[] {
  const text = git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (text.status !== 0) return [];
  return text.stdout.split('\n').filter(Boolean);
}

export function repoNameFromPath(repoPath: string): string {
  return path.basename(repoPath);
}
