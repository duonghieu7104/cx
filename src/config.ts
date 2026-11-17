import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, type Node } from 'yaml';
import { ConfigError, type ConfigIssue, CxError } from './errors.js';
import { compileRegex, packageRoot, parseDuration, uniqueStrings } from './util.js';

export type Actor = 'human' | 'agent' | 'cli';
export type StackMode = 'none' | 'per-lane' | 'shared';
export type WorkspaceMode = 'single-repo' | 'multi-repo';

export interface RepoConfig {
  id: string;
  alias: string[];
  path: string;
  absPath: string;
  base: string;
  checkout?: string;
  checkoutPath?: string;
  check: string;
  build: string;
  test: string;
  images: string[];
  services: string[];
}

export interface PhaseConfig {
  id: string;
  enabled: boolean;
  actor: Actor;
  skill?: string;
  subagent?: string;
  prompt?: string;
  gate?: string;
  command?: string;
  max_rounds?: number;
  retry_phase?: string;
}

export interface StackService {
  name: string;
  tag_var: string;
  image: string;
  kind: 'image' | 'mount';
  repo?: string;
  build?: string;
}

export interface GuardRule {
  pattern: string;
  reason: string;
}

export interface Config {
  version: 1;
  workspace: {
    mode: WorkspaceMode;
    root: string;
    repos: RepoConfig[];
  };
  worktree: {
    root: string;
    absRoot: string;
    pattern: string;
    branch_pattern: string;
  };
  tasks: {
    root: string;
    absRoot: string;
    state_file: string;
    events_file: string;
    folders: Record<string, string>;
  };
  phases: PhaseConfig[];
  stack: {
    mode: StackMode;
    compose_file: string;
    project_pattern: string;
    project: string;
    wrapper: string;
    wrapperPath: string;
    state_dir: string;
    stateDir: string;
    compose_files: string[];
    services: StackService[];
    lease_ttl: string;
    health_timeout: string;
    docker_bin: string;
    restore: {
      require_no_deps: boolean;
      export_all_baseline_tags: boolean;
      verify_before_release: boolean;
      on_mismatch: 'keep-lease' | 'release';
    };
  };
  queue: {
    mode: 'serial' | 'parallel';
    parallelism: number;
    cooldown: string;
    cooldownMs: number;
    dir: string;
    absDir: string;
  };
  gates: {
    require: string[];
    bind_to_head: boolean;
  };
  guards: {
    blocked_commands: GuardRule[];
    protected_files: string[];
    mcp_deny: string[];
    secret_assignments: string[];
    warn_patterns: string[];
    protect_primary_checkout: boolean;
  };
  notifications: {
    on_gate: 'none' | 'stdout' | 'command' | 'osascript';
    command: string;
    args: string[];
  };
  claude: {
    scope: 'project' | 'user';
    config_dir: string;
  };
  doctor: {
    env_files: string[];
  };
  configPath: string;
  configDir: string;
  workspaceRoot: string;
  userConfigPath?: string;
}

type Schema =
  | { t: 'string'; enum?: string[]; pattern?: string }
  | { t: 'number'; min?: number; integer?: boolean }
  | { t: 'boolean' }
  | { t: 'array'; items: Schema }
  | { t: 'object'; required?: string[]; props: Record<string, Schema>; extra?: Schema | false };

const PHASE_ID = '^[a-z][a-z0-9_]*$';
const REPO_ID = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
const BRANCH = '^[A-Za-z0-9._/-]+$';
const ENV_NAME = '^[A-Z_][A-Z0-9_]*$';

const GUARD_RULE: Schema = {
  t: 'object',
  required: ['pattern', 'reason'],
  extra: false,
  props: { pattern: { t: 'string' }, reason: { t: 'string' } },
};

const REPO_SCHEMA: Schema = {
  t: 'object',
  required: ['id', 'path', 'base'],
  extra: false,
  props: {
    id: { t: 'string', pattern: REPO_ID },
    alias: { t: 'array', items: { t: 'string' } },
    path: { t: 'string' },
    base: { t: 'string', pattern: BRANCH },
    checkout: { t: 'string' },
    check: { t: 'string' },
    build: { t: 'string' },
    test: { t: 'string' },
    images: { t: 'array', items: { t: 'string' } },
    services: { t: 'array', items: { t: 'string' } },
  },
};

const PHASE_SCHEMA: Schema = {
  t: 'object',
  required: ['id', 'actor'],
  extra: false,
  props: {
    id: { t: 'string', pattern: PHASE_ID },
    enabled: { t: 'boolean' },
    actor: { t: 'string', enum: ['human', 'agent', 'cli'] },
    skill: { t: 'string' },
    subagent: { t: 'string' },
    prompt: { t: 'string' },
    gate: { t: 'string' },
    command: { t: 'string', pattern: '^[a-z0-9_-]*$' },
    max_rounds: { t: 'number', integer: true, min: 1 },
    retry_phase: { t: 'string', pattern: PHASE_ID },
  },
};

const SERVICE_SCHEMA: Schema = {
  t: 'object',
  required: ['name', 'tag_var', 'image'],
  extra: false,
  props: {
    name: { t: 'string' },
    tag_var: { t: 'string', pattern: ENV_NAME },
    image: { t: 'string' },
    kind: { t: 'string', enum: ['image', 'mount'] },
    repo: { t: 'string' },
    build: { t: 'string' },
  },
};

const SCHEMA: Schema = {
  t: 'object',
  required: ['version', 'workspace', 'phases'],
  extra: false,
  props: {
    version: { t: 'number', integer: true },
    workspace: {
      t: 'object',
      required: ['mode', 'repos'],
      extra: false,
      props: {
        mode: { t: 'string', enum: ['single-repo', 'multi-repo'] },
        root: { t: 'string' },
        repos: { t: 'array', items: REPO_SCHEMA },
      },
    },
    worktree: {
      t: 'object',
      extra: false,
      props: {
        root: { t: 'string' },
        pattern: { t: 'string' },
        branch_pattern: { t: 'string' },
      },
    },
    tasks: {
      t: 'object',
      extra: false,
      props: {
        root: { t: 'string' },
        state_file: { t: 'string' },
        events_file: { t: 'string' },
        folders: { t: 'object', extra: { t: 'string' }, props: {} },
      },
    },
    phases: { t: 'array', items: PHASE_SCHEMA },
    stack: {
      t: 'object',
      extra: false,
      props: {
        mode: { t: 'string', enum: ['none', 'per-lane', 'shared'] },
        compose_file: { t: 'string' },
        project_pattern: { t: 'string' },
        project: { t: 'string' },
        wrapper: { t: 'string' },
        state_dir: { t: 'string' },
        compose_files: { t: 'array', items: { t: 'string' } },
        services: { t: 'array', items: SERVICE_SCHEMA },
        lease_ttl: { t: 'string' },
        health_timeout: { t: 'string' },
        docker_bin: { t: 'string' },
        restore: {
          t: 'object',
          extra: false,
          props: {
            require_no_deps: { t: 'boolean' },
            export_all_baseline_tags: { t: 'boolean' },
            verify_before_release: { t: 'boolean' },
            on_mismatch: { t: 'string', enum: ['keep-lease', 'release'] },
          },
        },
      },
    },
    queue: {
      t: 'object',
      extra: false,
      props: {
        mode: { t: 'string', enum: ['serial', 'parallel'] },
        parallelism: { t: 'number', integer: true, min: 1 },
        cooldown: { t: 'string' },
        dir: { t: 'string' },
      },
    },
    gates: {
      t: 'object',
      extra: false,
      props: {
        require: { t: 'array', items: { t: 'string' } },
        bind_to_head: { t: 'boolean' },
      },
    },
    guards: {
      t: 'object',
      extra: false,
      props: {
        blocked_commands: { t: 'array', items: GUARD_RULE },
        protected_files: { t: 'array', items: { t: 'string' } },
        mcp_deny: { t: 'array', items: { t: 'string' } },
        secret_assignments: { t: 'array', items: { t: 'string' } },
        warn_patterns: { t: 'array', items: { t: 'string' } },
        protect_primary_checkout: { t: 'boolean' },
      },
    },
    notifications: {
      t: 'object',
      extra: false,
      props: {
        on_gate: { t: 'string', enum: ['none', 'stdout', 'command', 'osascript'] },
        command: { t: 'string' },
        args: { t: 'array', items: { t: 'string' } },
      },
    },
    claude: {
      t: 'object',
      extra: false,
      props: {
        scope: { t: 'string', enum: ['project', 'user'] },
        config_dir: { t: 'string' },
      },
    },
    doctor: {
      t: 'object',
      extra: false,
      props: {
        env_files: { t: 'array', items: { t: 'string' } },
      },
    },
  },
};

const DEFAULT_FOLDERS: Record<string, string> = {
  intake: '.',
  proposal: '1-proposal',
  plan: '2-plan',
  plan_review: '.',
  ui: '3-ui',
  execute: '4-execute',
  checks: '4-execute',
  review: '4-execute',
  test_local: '5-test',
  gate: '.',
  commit: '.',
  pr: '.',
};

const CONFIG_NAMES = [
  'cx.config.yaml',
  'cx.config.yml',
  'cx.config.json',
  '.cx/config.yaml',
  '.cx/config.yml',
  '.cx/config.json',
];

export interface LoadOptions {
  /** Explicit project config. Hooks should leave this unset so CX_CONFIG cannot weaken policy. */
  configPath?: string;
  /** When false, CX_CONFIG is ignored. Hooks pass false. */
  honorEnvConfig?: boolean;
  /** Home directory used for ~/.config/cx. When omitted, HOME is used. Unset HOME skips the overlay. */
  home?: string;
  startDir?: string;
}

interface ParsedFile {
  file: string;
  text: string;
  value: unknown;
  doc: ReturnType<typeof parseDocument> | null;
}

export function configHome(explicit?: string): string | undefined {
  if (explicit !== undefined) return explicit || undefined;
  const fromEnv = process.env.CX_CONFIG_HOME || process.env.HOME;
  if (!fromEnv) return undefined;
  return fromEnv;
}

export function findProjectConfig(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    if (dir === root) return undefined;
    dir = path.dirname(dir);
  }
}

export function userConfigPath(home: string | undefined): string | undefined {
  if (!home) return undefined;
  for (const name of ['config.yaml', 'config.yml', 'config.json']) {
    const candidate = path.join(home, '.config', 'cx', name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function loadConfig(opts: LoadOptions = {}): Config {
  const start = path.resolve(opts.startDir ?? process.cwd());
  const honorEnv = opts.honorEnvConfig !== false;
  let projectFile = opts.configPath;
  if (!projectFile && honorEnv && process.env.CX_CONFIG) projectFile = process.env.CX_CONFIG;
  if (!projectFile) projectFile = findProjectConfig(start);
  if (!projectFile) {
    throw new CxError(
      `no cx config found from ${start}. Run \`cx init --preset single-repo\` or add cx.config.yaml.`,
    );
  }
  projectFile = path.resolve(projectFile);
  const project = readParsed(projectFile);
  const home = configHome(opts.home);
  const userFile = userConfigPath(home);
  const user = userFile ? readParsed(userFile) : undefined;

  const issues: ConfigIssue[] = [];
  collectSyntax(project, issues);
  if (user) collectSyntax(user, issues);
  if (issues.length) throw new ConfigError(issues);

  walk(project.value, SCHEMA, '', issues, project, false);
  if (user) walk(user.value, SCHEMA, '', issues, user, false);
  if (issues.length) throw new ConfigError(issues);
  if (project.value === null || project.value === undefined) {
    throw new ConfigError([{ file: project.file, path: '', message: 'config is empty' }]);
  }
  const userValue = user && user.value !== null && user.value !== undefined ? user.value : undefined;

  const merged = mergeOverlay(asRecord(project.value, project.file), userValue ? asRecord(userValue, user!.file) : undefined);
  const filled = applyDefaults(merged);
  walk(filled, SCHEMA, '', issues, project, true);
  semantic(filled, issues, project);
  if (issues.length) throw new ConfigError(issues);
  return materialize(filled, project.file, userFile);
}

function readParsed(file: string): ParsedFile {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    try {
      return { file, text, value: JSON.parse(text) as unknown, doc: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { file, text, value: undefined, doc: null, ...(message ? {} : {}) };
    }
  }
  const doc = parseDocument(text, { uniqueKeys: true, strict: false });
  return { file, text, value: doc.errors.length ? undefined : doc.toJS(), doc };
}

function collectSyntax(parsed: ParsedFile, issues: ConfigIssue[]): void {
  if (parsed.file.endsWith('.json') && parsed.value === undefined) {
    let message = 'invalid JSON';
    try {
      JSON.parse(parsed.text);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    issues.push({ file: parsed.file, path: '', message });
    return;
  }
  if (parsed.doc) {
    for (const err of parsed.doc.errors) {
      issues.push({
        file: parsed.file,
        path: '',
        message: err.message,
        line: err.linePos?.[0]?.line,
      });
    }
  }
}

function asRecord(value: unknown, file: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError([{ file, path: '', message: 'config must be a mapping' }]);
  }
  return value as Record<string, unknown>;
}

function mergeOverlay(project: Record<string, unknown>, user?: Record<string, unknown>): Record<string, unknown> {
  if (!user) return structuredClone(project);
  const merged = deepMerge(project, user) as Record<string, unknown>;
  if (user.guards && project.guards) {
    merged.guards = unionGuards(
      project.guards as Record<string, unknown>,
      user.guards as Record<string, unknown>,
    );
  }
  return merged;
}

function unionGuards(project: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const rules = [...asRules(project.blocked_commands), ...asRules(user.blocked_commands)];
  const seen = new Set<string>();
  const blocked: GuardRule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.pattern)) continue;
    seen.add(rule.pattern);
    blocked.push(rule);
  }
  return {
    blocked_commands: blocked,
    protected_files: uniqueStrings([...asStrings(project.protected_files), ...asStrings(user.protected_files)]),
    mcp_deny: uniqueStrings([...asStrings(project.mcp_deny), ...asStrings(user.mcp_deny)]),
    secret_assignments: uniqueStrings([
      ...asStrings(project.secret_assignments),
      ...asStrings(user.secret_assignments),
    ]),
    warn_patterns: uniqueStrings([...asStrings(project.warn_patterns), ...asStrings(user.warn_patterns)]),
    protect_primary_checkout: Boolean(project.protect_primary_checkout) || Boolean(user.protect_primary_checkout),
  };
}

function asRules(value: unknown): GuardRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is GuardRule => !!item && typeof item === 'object');
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over)) return structuredClone(over);
  if (isPlain(base) && isPlain(over)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(over as Record<string, unknown>)) {
      const next = (over as Record<string, unknown>)[key];
      out[key] = key in (base as Record<string, unknown>) ? deepMerge(out[key], next) : structuredClone(next);
    }
    return out;
  }
  return structuredClone(over);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function applyDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const cfg = structuredClone(raw);
  const workspace = asObj(cfg.workspace);
  workspace.root ??= '.';
  cfg.worktree = {
    root: '.worktrees',
    pattern: '{task}-{repo}',
    branch_pattern: '{type}/{task}',
    ...asObj(cfg.worktree),
  };
  const tasks = asObj(cfg.tasks);
  cfg.tasks = {
    root: 'docs/tasks',
    state_file: 'README.md',
    events_file: 'events.ndjson',
    ...tasks,
    folders: { ...DEFAULT_FOLDERS, ...asObj(tasks.folders) },
  };
  const stack = asObj(cfg.stack);
  const restore = asObj(stack.restore);
  cfg.stack = {
    mode: 'none',
    compose_file: 'docker-compose.yml',
    project_pattern: 'cx-{task}',
    project: '',
    wrapper: '',
    state_dir: '.cx/stack',
    compose_files: [],
    services: [],
    lease_ttl: '45m',
    health_timeout: '30s',
    docker_bin: 'docker',
    ...stack,
    restore: {
      require_no_deps: true,
      export_all_baseline_tags: true,
      verify_before_release: true,
      on_mismatch: 'keep-lease',
      ...restore,
    },
  };
  cfg.queue = {
    mode: 'serial',
    parallelism: 1,
    cooldown: '0s',
    dir: '.cx/queue',
    ...asObj(cfg.queue),
  };
  cfg.gates = {
    require: ['commit', 'push', 'pr'],
    bind_to_head: true,
    ...asObj(cfg.gates),
  };
  cfg.guards = {
    blocked_commands: [],
    protected_files: ['**/.env', '**/.env.*', '**/*.pem'],
    mcp_deny: [],
    secret_assignments: ['NPM_TOKEN=', 'AWS_SECRET_ACCESS_KEY=', 'PRIVATE_KEY='],
    warn_patterns: [],
    protect_primary_checkout: false,
    ...asObj(cfg.guards),
  };
  cfg.notifications = {
    on_gate: 'stdout',
    command: '',
    args: [],
    ...asObj(cfg.notifications),
  };
  cfg.claude = {
    scope: 'project',
    config_dir: '.claude',
    ...asObj(cfg.claude),
  };
  cfg.doctor = {
    env_files: [],
    ...asObj(cfg.doctor),
  };
  const repos = Array.isArray(workspace.repos) ? workspace.repos : [];
  workspace.repos = repos.map((repo) => ({
    alias: [],
    check: '',
    build: '',
    test: '',
    images: [],
    services: [],
    ...(isPlain(repo) ? repo : {}),
  }));
  const phases = Array.isArray(cfg.phases) ? cfg.phases : [];
  cfg.phases = phases.map((phase) => ({
    enabled: true,
    ...(isPlain(phase) ? phase : {}),
  }));
  const services = (cfg.stack as Record<string, unknown>).services;
  if (Array.isArray(services)) {
    (cfg.stack as Record<string, unknown>).services = services.map((svc) => ({
      kind: 'image',
      ...(isPlain(svc) ? svc : {}),
    }));
  }
  return cfg;
}

function asObj(value: unknown): Record<string, unknown> {
  return isPlain(value) ? value : {};
}

function walk(
  value: unknown,
  schema: Schema,
  pathName: string,
  issues: ConfigIssue[],
  parsed: ParsedFile,
  requireKeys: boolean,
): void {
  if (value === undefined) return;
  if (schema.t === 'string') {
    if (typeof value !== 'string') {
      issues.push(issue(parsed, pathName, `expected a string, got ${typeName(value)}`));
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      issues.push(issue(parsed, pathName, `expected one of ${schema.enum.join(' | ')}, got ${JSON.stringify(value)}`));
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      issues.push(issue(parsed, pathName, `must match ${schema.pattern}`));
    }
    return;
  }
  if (schema.t === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      issues.push(issue(parsed, pathName, `expected a number, got ${typeName(value)}`));
      return;
    }
    if (schema.integer && !Number.isInteger(value)) {
      issues.push(issue(parsed, pathName, 'expected an integer'));
    }
    if (schema.min !== undefined && value < schema.min) {
      issues.push(issue(parsed, pathName, `must be >= ${schema.min}`));
    }
    return;
  }
  if (schema.t === 'boolean') {
    if (typeof value !== 'boolean') {
      issues.push(issue(parsed, pathName, `expected a boolean, got ${typeName(value)}`));
    }
    return;
  }
  if (schema.t === 'array') {
    if (!Array.isArray(value)) {
      issues.push(issue(parsed, pathName, `expected a list, got ${typeName(value)}`));
      return;
    }
    value.forEach((item, index) => walk(item, schema.items, `${pathName}[${index}]`, issues, parsed, requireKeys));
    return;
  }
  if (!isPlain(value)) {
    issues.push(issue(parsed, pathName, `expected a mapping, got ${typeName(value)}`));
    return;
  }
  const record = value;
  if (requireKeys) {
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) issues.push(issue(parsed, joinPath(pathName, key), 'is required'));
    }
  }
  for (const key of Object.keys(record)) {
    const child = schema.props[key];
    const childPath = joinPath(pathName, key);
    if (!child) {
      if (schema.extra === false || schema.extra === undefined) {
        issues.push(issue(parsed, childPath, 'unknown key'));
      } else {
        walk(record[key], schema.extra, childPath, issues, parsed, requireKeys);
      }
      continue;
    }
    walk(record[key], child, childPath, issues, parsed, requireKeys);
  }
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'list';
  return typeof value;
}

function issue(parsed: ParsedFile, pathName: string, message: string): ConfigIssue {
  return { file: parsed.file, path: pathName, message, line: lineOf(parsed, pathName) };
}

function lineOf(parsed: ParsedFile, pathName: string): number | undefined {
  if (!parsed.doc || !pathName) return undefined;
  const parts = splitPath(pathName);
  const node = parsed.doc.getIn(parts, true) as Node | undefined;
  if (node?.range) return offsetToLine(parsed.text, node.range[0]);
  if (parts.length === 0) return undefined;
  const parent = parsed.doc.getIn(parts.slice(0, -1), true) as Node | undefined;
  const key = parts[parts.length - 1];
  const items = (parent as { items?: { key?: { value?: unknown; range?: [number, number, number] } }[] } | undefined)
    ?.items;
  if (!items || typeof key !== 'string') return undefined;
  for (const pair of items) {
    if (pair.key?.value === key && pair.key.range) return offsetToLine(parsed.text, pair.key.range[0]);
  }
  return undefined;
}

function splitPath(pathName: string): (string | number)[] {
  const parts: (string | number)[] = [];
  const re = /([^[.\]]+)|\[(\d+)\]/g;
  for (const match of pathName.matchAll(re)) {
    if (match[1] !== undefined) parts.push(match[1]);
    else if (match[2] !== undefined) parts.push(Number(match[2]));
  }
  return parts;
}

function offsetToLine(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function semantic(cfg: Record<string, unknown>, issues: ConfigIssue[], parsed: ParsedFile): void {
  if (cfg.version !== 1) {
    issues.push({ file: parsed.file, path: 'version', message: 'only version 1 is supported', line: lineOf(parsed, 'version') });
  }
  const workspace = asObj(cfg.workspace);
  const repos = Array.isArray(workspace.repos) ? (workspace.repos as Record<string, unknown>[]) : [];
  if (repos.length === 0) {
    issues.push({ file: parsed.file, path: 'workspace.repos', message: 'list at least one repo' });
  }
  const ids = new Set<string>();
  const aliases = new Set<string>();
  repos.forEach((repo, index) => {
    const id = String(repo.id ?? '');
    if (ids.has(id)) issues.push({ file: parsed.file, path: `workspace.repos[${index}].id`, message: `duplicate repo id ${id}` });
    ids.add(id);
    const aliasList = Array.isArray(repo.alias) ? (repo.alias as string[]) : [];
    for (const alias of aliasList) {
      const key = alias.toLowerCase();
      if (aliases.has(key) || [...ids].some((existing) => existing.toLowerCase() === key && existing !== id)) {
        issues.push({
          file: parsed.file,
          path: `workspace.repos[${index}].alias`,
          message: `alias ${alias} collides with another repo`,
        });
      }
      aliases.add(key);
    }
  });
  const worktree = asObj(cfg.worktree);
  const pattern = String(worktree.pattern ?? '');
  if (!pattern.includes('{task}')) {
    issues.push({ file: parsed.file, path: 'worktree.pattern', message: 'must include {task}' });
  }
  if (workspace.mode === 'multi-repo' && !pattern.includes('{repo}') && !pattern.includes('{alias}')) {
    issues.push({
      file: parsed.file,
      path: 'worktree.pattern',
      message: 'multi-repo layouts must include {repo} or {alias}',
    });
  }
  checkPlaceholders(String(worktree.branch_pattern ?? ''), 'worktree.branch_pattern', issues, parsed.file);
  const phases = Array.isArray(cfg.phases) ? (cfg.phases as Record<string, unknown>[]) : [];
  if (phases.length === 0) {
    issues.push({ file: parsed.file, path: 'phases', message: 'list at least one phase (see presets/single-repo.yaml)' });
  }
  const phaseIds = new Set<string>();
  for (const [index, phase] of phases.entries()) {
    const id = String(phase.id ?? '');
    if (phaseIds.has(id)) {
      issues.push({ file: parsed.file, path: `phases[${index}].id`, message: `duplicate phase id ${id}` });
    }
    phaseIds.add(id);
  }
  const stack = asObj(cfg.stack);
  if (stack.mode === 'shared') {
    if (!stack.wrapper) issues.push({ file: parsed.file, path: 'stack.wrapper', message: 'is required when stack.mode is shared' });
    if (!stack.project) issues.push({ file: parsed.file, path: 'stack.project', message: 'is required when stack.mode is shared' });
    const services = Array.isArray(stack.services) ? stack.services : [];
    if (services.length === 0) {
      issues.push({ file: parsed.file, path: 'stack.services', message: 'list the services a shared stack can swap' });
    }
    const names = new Set<string>();
    services.forEach((svc, index) => {
      const name = isPlain(svc) ? String(svc.name ?? '') : '';
      if (names.has(name)) {
        issues.push({ file: parsed.file, path: `stack.services[${index}].name`, message: `duplicate service ${name}` });
      }
      names.add(name);
    });
  }
  if (stack.mode === 'per-lane' && !stack.compose_file) {
    issues.push({ file: parsed.file, path: 'stack.compose_file', message: 'is required when stack.mode is per-lane' });
  }
  const queue = asObj(cfg.queue);
  if (queue.mode === 'serial' && queue.parallelism !== 1) {
    issues.push({ file: parsed.file, path: 'queue.parallelism', message: 'serial queues must set parallelism to 1' });
  }
  for (const [key, label] of [
    ['lease_ttl', 'stack.lease_ttl'],
    ['health_timeout', 'stack.health_timeout'],
  ] as const) {
    try {
      parseDuration(String(stack[key] ?? ''), label);
    } catch (err) {
      issues.push({ file: parsed.file, path: label, message: err instanceof Error ? err.message : String(err) });
    }
  }
  try {
    parseDuration(String(queue.cooldown ?? ''), 'queue.cooldown');
  } catch (err) {
    issues.push({
      file: parsed.file,
      path: 'queue.cooldown',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const notifications = asObj(cfg.notifications);
  if (notifications.on_gate === 'command' && !notifications.command) {
    issues.push({ file: parsed.file, path: 'notifications.command', message: 'is required when on_gate is command' });
  }
  const guards = asObj(cfg.guards);
  const rules = Array.isArray(guards.blocked_commands) ? guards.blocked_commands : [];
  rules.forEach((rule, index) => {
    if (!isPlain(rule)) return;
    try {
      compileRegex(String(rule.pattern ?? ''), `guards.blocked_commands[${index}].pattern`);
    } catch (err) {
      issues.push({
        file: parsed.file,
        path: `guards.blocked_commands[${index}].pattern`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
  for (const key of ['warn_patterns', 'secret_assignments'] as const) {
    const list = Array.isArray(guards[key]) ? (guards[key] as string[]) : [];
    list.forEach((pattern, index) => {
      try {
        compileRegex(pattern, `guards.${key}[${index}]`);
      } catch (err) {
        issues.push({
          file: parsed.file,
          path: `guards.${key}[${index}]`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }
}

function checkPlaceholders(pattern: string, pathName: string, issues: ConfigIssue[], file: string): void {
  const allowed = new Set(['task', 'repo', 'alias', 'type', 'desc']);
  for (const match of pattern.matchAll(/\{([^}]+)\}/g)) {
    if (!allowed.has(match[1])) {
      issues.push({ file, path: pathName, message: `unknown placeholder {${match[1]}}` });
    }
  }
}

function materialize(raw: Record<string, unknown>, configPath: string, userConfig: string | undefined): Config {
  const configDir = path.dirname(configPath);
  const workspace = asObj(raw.workspace);
  const workspaceRoot = path.resolve(configDir, String(workspace.root ?? '.'));
  const repos = (workspace.repos as Record<string, unknown>[]).map((repo) => {
    const rel = String(repo.path);
    const checkout = repo.checkout ? String(repo.checkout) : undefined;
    return {
      id: String(repo.id),
      alias: (repo.alias as string[]) ?? [],
      path: rel,
      absPath: path.resolve(workspaceRoot, rel),
      base: String(repo.base),
      checkout,
      checkoutPath: checkout ? path.resolve(workspaceRoot, checkout) : undefined,
      check: String(repo.check ?? ''),
      build: String(repo.build ?? ''),
      test: String(repo.test ?? ''),
      images: (repo.images as string[]) ?? [],
      services: (repo.services as string[]) ?? [],
    } satisfies RepoConfig;
  });
  const worktree = asObj(raw.worktree);
  const tasks = asObj(raw.tasks);
  const taskRootRel = String(tasks.root ?? 'docs/tasks');
  const stack = asObj(raw.stack);
  const queue = asObj(raw.queue);
  const cooldownMs = parseDuration(String(queue.cooldown), 'queue.cooldown');
  const resolveFromRoot = (value: string) => (path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value));
  return {
    version: 1,
    workspace: { mode: workspace.mode as WorkspaceMode, root: String(workspace.root ?? '.'), repos },
    worktree: {
      root: String(worktree.root),
      absRoot: resolveFromRoot(String(worktree.root)),
      pattern: String(worktree.pattern),
      branch_pattern: String(worktree.branch_pattern),
    },
    tasks: {
      root: taskRootRel,
      absRoot:
        taskRootRel === 'none' || taskRootRel === ''
          ? path.join(workspaceRoot, '.cx', 'tasks')
          : resolveFromRoot(taskRootRel),
      state_file: String(tasks.state_file),
      events_file: String(tasks.events_file),
      folders: tasks.folders as Record<string, string>,
    },
    phases: raw.phases as PhaseConfig[],
    stack: {
      mode: stack.mode as StackMode,
      compose_file: String(stack.compose_file ?? ''),
      project_pattern: String(stack.project_pattern ?? 'cx-{task}'),
      project: String(stack.project ?? ''),
      wrapper: String(stack.wrapper ?? ''),
      wrapperPath: stack.wrapper ? resolveFromRoot(String(stack.wrapper)) : '',
      state_dir: String(stack.state_dir ?? '.cx/stack'),
      stateDir: resolveFromRoot(String(stack.state_dir ?? '.cx/stack')),
      compose_files: (stack.compose_files as string[]) ?? [],
      services: stack.services as StackService[],
      lease_ttl: String(stack.lease_ttl),
      health_timeout: String(stack.health_timeout),
      docker_bin: process.env.CX_DOCKER || String(stack.docker_bin || 'docker'),
      restore: stack.restore as Config['stack']['restore'],
    },
    queue: {
      mode: queue.mode as 'serial' | 'parallel',
      parallelism: Number(queue.parallelism),
      cooldown: String(queue.cooldown),
      cooldownMs,
      dir: String(queue.dir),
      absDir: resolveFromRoot(String(queue.dir)),
    },
    gates: raw.gates as Config['gates'],
    guards: raw.guards as Config['guards'],
    notifications: raw.notifications as Config['notifications'],
    claude: raw.claude as Config['claude'],
    doctor: raw.doctor as Config['doctor'],
    configPath,
    configDir,
    workspaceRoot,
    userConfigPath: userConfig,
  };
}

export function findRepo(cfg: Config, name: string): RepoConfig {
  const needle = name.toLowerCase();
  const hits = cfg.workspace.repos.filter(
    (repo) => repo.id === name || repo.id.toLowerCase() === needle || repo.alias.some((alias) => alias.toLowerCase() === needle),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    const known = cfg.workspace.repos.map((repo) => repo.alias[0] || repo.id).join(', ');
    throw new CxError(`unknown repo ${JSON.stringify(name)}. Known: ${known || '(none)'}`);
  }
  throw new CxError(`repo name ${JSON.stringify(name)} matches more than one repo`);
}

export function enabledPhases(cfg: Config): PhaseConfig[] {
  return cfg.phases.filter((phase) => phase.enabled);
}

export function phaseById(cfg: Config, id: string): PhaseConfig | undefined {
  return cfg.phases.find((phase) => phase.id === id);
}

export function presetDir(): string {
  return path.join(packageRoot(), 'presets');
}

export function presetNames(): string[] {
  return fs
    .readdirSync(presetDir())
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.replace(/\.yaml$/, ''))
    .sort();
}

export function readPreset(name: string): { file: string; text: string } {
  if (!/^[a-z0-9-]+$/.test(name)) throw new CxError(`unknown preset ${JSON.stringify(name)}`);
  const file = path.join(presetDir(), `${name}.yaml`);
  if (!fs.existsSync(file)) {
    throw new CxError(`unknown preset ${JSON.stringify(name)}. Available: ${presetNames().join(', ')}`);
  }
  return { file, text: fs.readFileSync(file, 'utf8') };
}

export function publicConfig(cfg: Config): unknown {
  return {
    version: cfg.version,
    workspace: {
      mode: cfg.workspace.mode,
      root: cfg.workspace.root,
      repos: cfg.workspace.repos.map((repo) => ({
        id: repo.id,
        alias: repo.alias,
        path: repo.path,
        base: repo.base,
        checkout: repo.checkout,
        check: repo.check,
        build: repo.build,
        test: repo.test,
        images: repo.images,
        services: repo.services,
      })),
    },
    worktree: { root: cfg.worktree.root, pattern: cfg.worktree.pattern, branch_pattern: cfg.worktree.branch_pattern },
    tasks: {
      root: cfg.tasks.root,
      state_file: cfg.tasks.state_file,
      events_file: cfg.tasks.events_file,
      folders: cfg.tasks.folders,
    },
    phases: cfg.phases,
    stack: {
      mode: cfg.stack.mode,
      compose_file: cfg.stack.compose_file,
      project_pattern: cfg.stack.project_pattern,
      project: cfg.stack.project,
      wrapper: cfg.stack.wrapper,
      state_dir: cfg.stack.state_dir,
      compose_files: cfg.stack.compose_files,
      services: cfg.stack.services,
      lease_ttl: cfg.stack.lease_ttl,
      health_timeout: cfg.stack.health_timeout,
      restore: cfg.stack.restore,
    },
    queue: {
      mode: cfg.queue.mode,
      parallelism: cfg.queue.parallelism,
      cooldown: cfg.queue.cooldown,
      dir: cfg.queue.dir,
    },
    gates: cfg.gates,
    guards: cfg.guards,
    notifications: cfg.notifications,
    claude: cfg.claude,
    doctor: cfg.doctor,
    files: { project: cfg.configPath, user: cfg.userConfigPath ?? null, workspace: cfg.workspaceRoot },
  };
}

export function jsonSchema(): unknown {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/duonghieu7104/cx/cx.config.schema.json',
    title: 'cx config',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'workspace', 'phases'],
    properties: {
      version: { const: 1 },
      workspace: {
        type: 'object',
        required: ['mode', 'repos'],
        properties: {
          mode: { enum: ['single-repo', 'multi-repo'] },
          root: { type: 'string' },
          repos: { type: 'array', items: { type: 'object' } },
        },
      },
      worktree: { type: 'object' },
      tasks: { type: 'object' },
      phases: { type: 'array' },
      stack: { type: 'object' },
      queue: { type: 'object' },
      gates: { type: 'object' },
      guards: { type: 'object' },
      notifications: { type: 'object' },
      claude: { type: 'object' },
      doctor: { type: 'object' },
    },
  };
}
