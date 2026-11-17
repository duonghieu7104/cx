import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CxError } from './errors.js';
import { atomicWrite, mkdirp, packageRoot } from './util.js';

interface Manifest {
  files: { path: string; sha256: string }[];
}

const COPIES: { from: string; to: string }[] = [
  { from: 'skills/cx-setup/SKILL.md', to: 'skills/cx-setup/SKILL.md' },
  { from: 'commands/cx-setup.md', to: 'commands/cx-setup.md' },
  { from: 'commands/ship-task.md', to: 'commands/ship-task.md' },
  { from: 'commands/cx-status.md', to: 'commands/cx-status.md' },
  { from: 'agents/cx-implementer.md', to: 'agents/cx-implementer.md' },
  { from: 'agents/cx-reviewer.md', to: 'agents/cx-reviewer.md' },
  { from: 'agents/cx-qc.md', to: 'agents/cx-qc.md' },
  { from: 'hooks/run.mjs', to: 'hooks/run.mjs' },
  { from: 'hooks/bash-guard.mjs', to: 'hooks/bash-guard.mjs' },
  { from: 'hooks/edit-guard.mjs', to: 'hooks/edit-guard.mjs' },
  { from: 'hooks/mcp-guard.mjs', to: 'hooks/mcp-guard.mjs' },
  { from: 'hooks/lease-safety.mjs', to: 'hooks/lease-safety.mjs' },
];

export interface InstallResult {
  claudeDir: string;
  wrote: string[];
  skipped: string[];
  settings: string;
}

export function installClaude(opts: { claudeDir: string; cliPath?: string }): InstallResult {
  const claudeDir = path.resolve(opts.claudeDir);
  const source = path.join(packageRoot(), 'claude');
  const cliPath = opts.cliPath ?? path.join(packageRoot(), 'dist', 'src', 'cli.js');
  mkdirp(claudeDir);
  const wrote: string[] = [];
  const skipped: string[] = [];
  const installed: { path: string; sha256: string }[] = [];
  for (const item of COPIES) {
    const from = path.join(source, item.from);
    if (!fs.existsSync(from)) throw new CxError(`missing harness asset ${item.from}`);
    let body = fs.readFileSync(from, 'utf8');
    if (item.to === 'hooks/run.mjs') body = body.replaceAll('__CX_CLI__', cliPath);
    const dest = path.join(claudeDir, item.to);
    const digest = sha(body);
    if (fs.existsSync(dest)) {
      const current = fs.readFileSync(dest, 'utf8');
      if (current === body) {
        installed.push({ path: item.to, sha256: digest });
        continue;
      }
      skipped.push(item.to);
      continue;
    }
    mkdirp(path.dirname(dest));
    atomicWrite(dest, body, item.to.endsWith('.mjs') ? 0o755 : 0o644);
    wrote.push(item.to);
    installed.push({ path: item.to, sha256: digest });
  }
  const settings = mergeSettings(claudeDir, installed);
  const manifest: Manifest = { files: installed };
  atomicWrite(path.join(claudeDir, '.cx-install.json'), JSON.stringify(manifest, null, 2));
  return { claudeDir, wrote, skipped, settings };
}

export function uninstallClaude(claudeDir: string): { removed: string[]; kept: string[] } {
  const root = path.resolve(claudeDir);
  const manifestPath = path.join(root, '.cx-install.json');
  if (!fs.existsSync(manifestPath)) throw new CxError(`no cx install manifest in ${root}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  const removed: string[] = [];
  const kept: string[] = [];
  for (const file of manifest.files) {
    const dest = path.join(root, file.path);
    if (!fs.existsSync(dest)) continue;
    if (sha(fs.readFileSync(dest, 'utf8')) !== file.sha256) {
      kept.push(file.path);
      continue;
    }
    fs.rmSync(dest, { force: true });
    removed.push(file.path);
  }
  const settingsPath = path.join(root, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Settings;
    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        settings.hooks[event] = (settings.hooks[event] ?? [])
          .map((group) => ({
            ...group,
            hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? '').includes(`${path.sep}.claude${path.sep}hooks${path.sep}`) && !isOurHook(hook.command, root)),
          }))
          .filter((group) => (group.hooks ?? []).length > 0);
      }
      atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }
  fs.rmSync(manifestPath, { force: true });
  return { removed, kept };
}

interface HookCommand {
  type: string;
  command: string;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function mergeSettings(claudeDir: string, installed: { path: string }[]): string {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const existing: Settings = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Settings)
    : {};
  if (fs.existsSync(settingsPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(settingsPath, path.join(claudeDir, `settings.json.cx-bak-${stamp}`));
  }
  const hooks = existing.hooks ?? {};
  const have = new Set(installed.map((file) => file.path));
  const node = process.execPath;
  const add = (event: string, matcher: string | undefined, script: string) => {
    if (!have.has(`hooks/${script}`)) return;
    const command = `${node} ${shellQuote(path.join(claudeDir, 'hooks', script))}`;
    const groups = hooks[event] ?? [];
    const group = matcher
      ? groups.find((item) => item.matcher === matcher)
      : groups.find((item) => !item.matcher);
    if (group) {
      if (!group.hooks.some((hook) => hook.command.includes(script))) group.hooks.push({ type: 'command', command });
    } else {
      const created: HookGroup = { hooks: [{ type: 'command', command }] };
      if (matcher) created.matcher = matcher;
      groups.push(created);
    }
    hooks[event] = groups;
  };
  add('PreToolUse', 'Bash', 'bash-guard.mjs');
  add('PreToolUse', 'Edit|Write', 'edit-guard.mjs');
  add('PreToolUse', 'mcp__.*', 'mcp-guard.mjs');
  add('Stop', undefined, 'lease-safety.mjs');
  add('SessionEnd', undefined, 'lease-safety.mjs');
  existing.hooks = hooks;
  atomicWrite(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
  return settingsPath;
}

function isOurHook(command: string | undefined, claudeDir: string): boolean {
  if (!command) return false;
  return command.includes(path.join(claudeDir, 'hooks'));
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
