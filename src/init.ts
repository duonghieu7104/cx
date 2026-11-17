import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadConfig, readPreset } from './config.js';
import { CxError } from './errors.js';
import { inspectProject, type InspectReport } from './inspect.js';
import { atomicWrite, mkdirp } from './util.js';

const USER_EXAMPLE = `# Personal cx overrides (~/.config/cx/config.yaml).
# Copy this file to config.yaml to use it.
# Notifications and queue cooldown override the project.
# Guard lists are additive: a project rule cannot be erased from here.
#
# notifications:
#   on_gate: osascript
# queue:
#   cooldown: 30s
`;

export function initPreset(cwd: string, preset: string, opts: { force?: boolean; home?: string } = {}): string {
  const target = path.join(path.resolve(cwd), 'cx.config.yaml');
  if (fs.existsSync(target) && !opts.force) {
    throw new CxError(`${target} already exists. Pass --force to replace it.`);
  }
  const report = inspectProject(cwd, opts.home);
  let text = readPreset(preset).text;
  if (!text.startsWith('# cx config')) {
    text = `# cx config written by \`cx init --preset ${preset}\`\n${text}`;
  }
  text = applyInitMarkers(text, report);
  atomicWrite(target, text.endsWith('\n') ? text : `${text}\n`);
  ensureUserConfig(opts.home);
  ensureGitignore(cwd);
  return target;
}

export function initFromInspect(cwd: string, opts: { force?: boolean; home?: string } = {}): string {
  const target = path.join(path.resolve(cwd), 'cx.config.yaml');
  if (fs.existsSync(target) && !opts.force) {
    throw new CxError(`${target} already exists. Pass --force to replace it.`);
  }
  const report = inspectProject(cwd, opts.home);
  const header = [
    '# cx config drafted by `cx init --from-inspect`.',
    '# Review the assumptions, then run `cx config validate` and `cx doctor`.',
    ...report.questions.map((question) => `# Question: ${question}`),
    `# Assumed preset ${report.suggestedPreset}, base ${report.suggested.base}, check ${report.suggested.check}, stack ${report.suggested.stackMode}.`,
    '',
  ].join('\n');
  const body = stringify(JSON.parse(JSON.stringify(draftConfig(report))) as Record<string, unknown>);
  atomicWrite(target, `${header}${body}`);
  ensureUserConfig(opts.home);
  ensureGitignore(cwd);
  return target;
}

function applyInitMarkers(text: string, report: InspectReport): string {
  return text
    .replace(/^(\s*base:\s*)\S+(.*# cx-init:base.*)$/gm, `$1${report.suggested.base}$2`)
    .replace(/^(\s*check:\s*)"(?:true)?"(.*# cx-init:check.*)$/gm, (_all, prefix: string, suffix: string) => {
      return `${prefix}${JSON.stringify(report.suggested.check)}${suffix}`;
    });
}

function draftConfig(report: InspectReport): Record<string, unknown> {
  const skill = (name: string) => (report.plugins.superpowers ? name : undefined);
  const repos =
    report.suggestedPreset === 'multi-repo'
      ? report.children.map((repo) => ({
          id: repo.name,
          path: repo.name,
          base: repo.branch || report.suggested.base,
          check: 'true',
        }))
      : [
          {
            id: 'app',
            path: '.',
            base: report.suggested.base,
            check: report.suggested.check,
          },
        ];
  return {
    version: 1,
    workspace: { mode: report.suggestedPreset, root: '.', repos },
    worktree: { root: report.suggested.worktreeRoot, pattern: '{task}-{repo}', branch_pattern: '{type}/{task}' },
    tasks: { root: report.suggested.taskRoot, state_file: 'README.md', events_file: 'events.ndjson' },
    phases: [
      { id: 'intake', actor: 'cli', enabled: true },
      { id: 'proposal', actor: 'agent', enabled: true, skill: skill('superpowers:brainstorming'), prompt: 'builtin:proposal' },
      { id: 'plan', actor: 'agent', enabled: true, skill: skill('superpowers:writing-plans'), prompt: 'builtin:plan' },
      { id: 'plan_review', actor: 'human', enabled: true, gate: 'plan' },
      {
        id: 'execute',
        actor: 'agent',
        enabled: true,
        subagent: 'cx-implementer',
        skill: skill('superpowers:test-driven-development'),
        prompt: 'builtin:execute',
      },
      { id: 'checks', actor: 'cli', enabled: true, command: 'check' },
      {
        id: 'review',
        actor: 'agent',
        enabled: true,
        subagent: 'cx-reviewer',
        skill: skill('superpowers:requesting-code-review'),
        prompt: 'builtin:review',
        max_rounds: 2,
        retry_phase: 'execute',
      },
      {
        id: 'test_local',
        actor: 'agent',
        enabled: report.suggested.stackMode !== 'none',
        subagent: 'cx-qc',
        prompt: 'builtin:test-local',
        command: 'test-local',
      },
      { id: 'gate', actor: 'human', enabled: true, gate: 'commit' },
    ],
    stack:
      report.suggested.stackMode === 'per-lane'
        ? { mode: 'per-lane', compose_file: report.composeFiles[0] ?? 'docker-compose.yml', project_pattern: 'cx-{task}' }
        : { mode: 'none' },
    queue: { mode: 'serial', parallelism: 1, cooldown: '0s', dir: '.cx/queue' },
    gates: { require: ['plan', 'commit', 'push', 'pr'], bind_to_head: true },
    guards: {
      protect_primary_checkout: true,
      blocked_commands: [
        {
          pattern: '(^|[;&|]|\\n)\\s*cx\\s+approve\\b',
          reason: 'cx approve is a human gate. Run it in your terminal.',
        },
        {
          pattern: '(^|[;&|]|\\n)\\s*git\\s+push\\b',
          reason: 'Push through cx pr after cx approve push.',
        },
      ],
      protected_files: ['**/.env', '**/.env.*', '**/*.pem'],
      mcp_deny: ['*payment*', '*budget*'],
    },
    notifications: { on_gate: 'stdout' },
  };
}

export function ensureUserConfig(home: string | undefined): void {
  const root = home ?? process.env.CX_CONFIG_HOME ?? process.env.HOME;
  if (!root) return;
  const dir = path.join(root, '.config', 'cx');
  mkdirp(dir, 0o700);
  const example = path.join(dir, 'config.yaml.example');
  if (!fs.existsSync(example)) atomicWrite(example, USER_EXAMPLE, 0o600);
}

export function ensureGitignore(cwd: string): void {
  let cfg;
  try {
    cfg = loadConfig({ startDir: cwd, honorEnvConfig: false, home: '' });
  } catch {
    return;
  }
  const patterns = [cfg.worktree.root, cfg.queue.dir, cfg.stack.state_dir, '.cx/']
    .filter((entry) => entry && !path.isAbsolute(entry) && !entry.startsWith('..'));
  const file = path.join(path.resolve(cwd), '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = patterns.filter((entry) => !current.split('\n').some((line) => line.trim() === entry));
  if (missing.length === 0) return;
  const next = `${current.trimEnd()}\n${current.trim() ? '\n' : ''}# cx\n${missing.join('\n')}\n`;
  atomicWrite(file, next);
}
