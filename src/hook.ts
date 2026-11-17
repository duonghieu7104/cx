import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import { releaseIfHeld } from './stack.js';
import { laneAbs, listTaskIds, readState } from './state.js';
import { compileRegex, insideRoot, matchAnyGlob, matchGlob } from './util.js';

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export function runHook(which: 'bash' | 'edit' | 'mcp' | 'lease'): number {
  const input = readInput();
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let cfg: Config;
  try {
    cfg = loadConfig({ startDir: cwd, honorEnvConfig: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (which === 'lease') {
      process.stderr.write(`cx lease hook: ${message}\n`);
      return 0;
    }
    return deny(input, `cx hook could not load a project config (${message})`);
  }
  if (which === 'lease') return leaseHook(cfg);
  if (which === 'bash') return bashHook(cfg, input);
  if (which === 'edit') return editHook(cfg, input);
  return mcpHook(cfg, input);
}

function bashHook(cfg: Config, input: HookInput): number {
  const command = String(input.tool_input?.command ?? '');
  if (!command) return allow(input);
  if (/(^|[;&|]|\n)\s*cx\s+approve\b/.test(command)) {
    return deny(input, 'cx approve is a human gate. Run it in your own terminal.');
  }
  for (const rule of cfg.guards.blocked_commands) {
    if (compileRegex(rule.pattern, 'blocked command').test(command)) return deny(input, rule.reason);
  }
  for (const pattern of cfg.guards.secret_assignments) {
    if (compileRegex(pattern, 'secret assignment').test(command)) {
      return deny(input, 'refusing a command that assigns or prints a secret');
    }
  }
  for (const pattern of cfg.guards.warn_patterns) {
    if (compileRegex(pattern, 'warn pattern').test(command)) return warn(input, `cx warning: command matches /${pattern}/`);
  }
  return allow(input);
}

function editHook(cfg: Config, input: HookInput): number {
  const toolInput = input.tool_input ?? {};
  const file = String(toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path ?? '');
  if (file && matchAnyGlob(cfg.guards.protected_files, file)) {
    return deny(input, `refusing to edit protected file ${file}`);
  }
  const content = [toolInput.content, toolInput.new_string, toolInput.new_source]
    .filter((item) => typeof item === 'string')
    .join('\n');
  for (const pattern of cfg.guards.secret_assignments) {
    if (content && compileRegex(pattern, 'secret assignment').test(content)) {
      return deny(input, 'refusing to write a secret assignment');
    }
  }
  if (file && cfg.guards.protect_primary_checkout && blockedPrimaryEdit(cfg, file)) {
    return deny(input, `refusing to edit the primary checkout (${file}). Edit the task worktree instead.`);
  }
  return allow(input);
}

function mcpHook(cfg: Config, input: HookInput): number {
  const tool = input.tool_name ?? '';
  const blob = `${tool}\n${JSON.stringify(input.tool_input ?? {})}`;
  for (const pattern of cfg.guards.mcp_deny) {
    if (globHit(pattern, tool, blob)) return deny(input, `MCP tool blocked by cx deny pattern ${pattern}`);
  }
  return allow(input);
}

function leaseHook(cfg: Config): number {
  const result = releaseIfHeld(cfg);
  if (result.error) {
    process.stderr.write(`${result.error}\nRun cx stack recover --yes\n`);
    return 2;
  }
  if (result.released) process.stderr.write(`cx released the stack lease for ${result.task}\n`);
  return 0;
}

function blockedPrimaryEdit(cfg: Config, file: string): boolean {
  const abs = path.resolve(file);
  const base = path.basename(abs);
  if (base === 'cx.config.yaml' || base === 'cx.config.yml' || base === 'cx.config.json') return false;
  if (insideRoot(cfg.tasks.absRoot, abs)) return false;
  if (insideRoot(cfg.worktree.absRoot, abs)) return false;
  for (const id of listTaskIds(cfg)) {
    for (const lane of readState(cfg, id).lanes) {
      if (insideRoot(laneAbs(cfg, lane), abs)) return false;
    }
  }
  return cfg.workspace.repos.some((repo) => fs.existsSync(repo.absPath) && insideRoot(repo.absPath, abs));
}

function globHit(pattern: string, tool: string, blob: string): boolean {
  if (matchGlob(pattern, tool)) return true;
  for (const part of tool.split('__')) {
    if (matchGlob(pattern, part)) return true;
  }
  try {
    const source = matchGlob(pattern, blob) ? '' : '';
    void source;
    const body = pattern.replaceAll('**', '*');
    const regex = new RegExp(body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*'));
    return regex.test(tool) || regex.test(blob);
  } catch {
    return false;
  }
}

function readInput(): HookInput {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

function deny(input: HookInput, reason: string): number {
  const event = input.hook_event_name ?? 'PreToolUse';
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.stderr.write(`${reason}\n`);
  return 2;
}

function warn(input: HookInput, reason: string): number {
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: reason,
      hookSpecificOutput: {
        hookEventName: input.hook_event_name ?? 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  return 0;
}

function allow(input: HookInput): number {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name ?? 'PreToolUse',
        permissionDecision: 'allow',
      },
    })}\n`,
  );
  return 0;
}
