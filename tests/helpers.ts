import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const cliPath = path.join(repoRoot, 'dist', 'src', 'cli.js');

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  home: string;
}

export function runCx(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; home?: string } = {},
): RunResult {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cx-home-'));
  fs.mkdirSync(home, { recursive: true });
  const gitconfig = path.join(home, '.gitconfig');
  if (!fs.existsSync(gitconfig)) {
    fs.writeFileSync(
      gitconfig,
      '[user]\n\temail = cx-test@example.com\n\tname = cx test\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[safe]\n\tdirectory = *\n',
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete env.CX_CONFIG;
  delete env.CX_DOCKER;
  delete env.CX_LEASE_TOKEN;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CX_ACTOR;
  Object.assign(env, opts.env);
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: opts.cwd,
    env,
    input: opts.input,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    home,
  };
}

export function tempDir(prefix = 'cx-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function gitInit(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  };
  git(['init', '-b', branch]);
  git(['config', 'user.email', 'cx-test@example.com']);
  git(['config', 'user.name', 'cx test']);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  git(['add', 'README.md']);
  git(['commit', '-m', 'init']);
}

export function writeFakeBinaries(dir: string, stateFile: string, logFile: string): { docker: string; wrapper: string } {
  fs.mkdirSync(dir, { recursive: true });
  const docker = path.join(dir, 'docker');
  const wrapper = path.join(dir, 'wrapper');
  const dockerJs = path.join(dir, 'docker.mjs');
  const wrapperJs = path.join(dir, 'wrapper.mjs');
  fs.writeFileSync(dockerJs, fakeDocker(stateFile, logFile));
  fs.writeFileSync(wrapperJs, fakeWrapper(stateFile, logFile));
  fs.writeFileSync(docker, shellNode(dockerJs), { mode: 0o755 });
  fs.writeFileSync(wrapper, shellNode(wrapperJs), { mode: 0o755 });
  return { docker, wrapper };
}

function shellNode(script: string): string {
  return `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`;
}

function fakeDocker(stateFile: string, logFile: string): string {
  return `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: args }) + '\\n');
if (args[0] === 'compose' && args.includes('ps')) {
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  process.stdout.write(state.services.map((row) => JSON.stringify(row)).join('\\n') + '\\n');
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') process.exit(0);
if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('docker fake\\n');
  process.exit(0);
}
process.exit(0);
`;
}

function fakeWrapper(stateFile: string, logFile: string): string {
  return `import fs from 'node:fs';
const args = process.argv.slice(2);
const batch = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('BATCH_') || key.startsWith('REPLACE_ME_')) batch[key] = value;
}
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ wrapper: true, args, batch }) + '\\n');
if (!args.includes('--no-deps')) {
  console.error('missing --no-deps');
  process.exit(2);
}
if (fs.existsSync(${JSON.stringify(`${stateFile}.noop`)})) process.exit(0);
const service = args[args.length - 1];
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const item = state.services.find((row) => row.Service === service);
if (item) {
  const value = process.env[item.TagVar];
  if (value) {
    if (item.Kind === 'mount') item.Mount = value;
    else item.Image = String(item.Image).split(':')[0] + ':' + value;
    fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  }
}
process.exit(0);
`;
}

export function readLog(file: string): { argv?: string[]; wrapper?: boolean; args?: string[]; batch?: Record<string, string> }[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { argv?: string[]; wrapper?: boolean; args?: string[]; batch?: Record<string, string> });
}
