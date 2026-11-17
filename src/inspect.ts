import fs from 'node:fs';
import path from 'node:path';
import { commandExists } from './util.js';
import { currentBranch, findGitRoot, localBranches } from './git.js';

export interface InspectReport {
  cwd: string;
  git: {
    isRepo: boolean;
    root?: string;
    branch?: string;
    remotes: string[];
    branches: string[];
  };
  children: { name: string; path: string; branch: string }[];
  neighbors: { name: string; path: string; branch: string }[];
  packageManager: string;
  scripts: Record<string, string>;
  makefileTargets: string[];
  composeFiles: string[];
  taskDirs: string[];
  worktreeDirs: string[];
  plugins: { superpowers: boolean; graphify: boolean; gitnexus: boolean; claudeMem: boolean };
  suggestedPreset: 'single-repo' | 'multi-repo';
  suggested: { base: string; check: string; stackMode: 'none' | 'per-lane'; taskRoot: string; worktreeRoot: string };
  questions: string[];
}

export function inspectProject(cwd: string, home?: string): InspectReport {
  const root = path.resolve(cwd);
  const gitRoot = findGitRoot(root);
  const children = gitRoot ? [] : childRepos(root);
  const neighbors = gitRoot ? siblingRepos(gitRoot) : [];
  const focus = gitRoot ?? root;
  const pkg = readPackage(focus);
  const packageManager = detectPackageManager(focus);
  const makefileTargets = readMakeTargets(focus);
  const composeFiles = findCompose(focus);
  const taskDirs = ['docs/tasks', 'plans', 'tasks'].filter((rel) => fs.existsSync(path.join(root, rel)));
  const worktreeDirs = ['.worktrees', 'worktrees', '.worktree'].filter((rel) => fs.existsSync(path.join(root, rel)));
  const plugins = detectPlugins(root, home);
  const check = suggestCheck(focus, packageManager, pkg.scripts, makefileTargets);
  const base = currentBranch(focus) || 'main';
  const multi = !gitRoot && children.length >= 2;
  const questions: string[] = [];
  if (composeFiles.length > 0) {
    questions.push(
      'Compose files are present. Should stack.mode be per-lane, shared (one wrapper command and a lease), or none?',
    );
  }
  if (neighbors.length >= 2) {
    questions.push('Neighboring git repositories were found. Is this a multi-repo workspace that should list them?');
  }
  if (taskDirs.length > 1) {
    questions.push(`More than one task folder exists (${taskDirs.join(', ')}). Which one should cx use?`);
  }
  const branches = gitRoot ? localBranches(gitRoot) : [];
  if (branches.includes('main') && (branches.includes('dev') || branches.includes('develop'))) {
    questions.push('Both main and a development branch exist. Which is the base branch for new work?');
  }
  if (!check) questions.push('No test script was found. What command should cx check run?');
  return {
    cwd: root,
    git: {
      isRepo: Boolean(gitRoot),
      root: gitRoot,
      branch: gitRoot ? currentBranch(gitRoot) : undefined,
      remotes: gitRoot ? readRemotes(gitRoot) : [],
      branches,
    },
    children,
    neighbors,
    packageManager,
    scripts: pkg.scripts,
    makefileTargets,
    composeFiles,
    taskDirs,
    worktreeDirs,
    plugins,
    suggestedPreset: multi ? 'multi-repo' : 'single-repo',
    suggested: {
      base: base || 'main',
      check: check || 'true',
      stackMode: composeFiles.length ? 'per-lane' : 'none',
      taskRoot: taskDirs[0] ?? 'docs/tasks',
      worktreeRoot: worktreeDirs[0] ?? '.worktrees',
    },
    questions,
  };
}

function readPackage(dir: string): { scripts: Record<string, string> } {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return { scripts: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
    return { scripts: parsed.scripts ?? {} };
  } catch {
    return { scripts: {} };
  }
}

function detectPackageManager(dir: string): string {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'package.json'))) return 'npm';
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'cargo';
  return 'none';
}

function suggestCheck(dir: string, pm: string, scripts: Record<string, string>, targets: string[]): string {
  const test = scripts.test ?? '';
  if (test && !/no test specified/i.test(test)) {
    if (pm === 'pnpm' || pm === 'yarn' || pm === 'bun' || pm === 'npm') return `${pm} test`;
  }
  if (scripts.typecheck) return `${pm} run typecheck`;
  if (targets.includes('check')) return 'make check';
  if (targets.includes('test')) return 'make test';
  if (pm === 'go') return 'go test ./...';
  if (pm === 'python' && fs.existsSync(path.join(dir, 'pyproject.toml'))) return 'python -m pytest';
  if (pm === 'cargo') return 'cargo test';
  return '';
}

function readMakeTargets(dir: string): string[] {
  const file = path.join(dir, 'Makefile');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((match) => match[1]);
}

function findCompose(dir: string): string[] {
  const names = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  return names.filter((name) => fs.existsSync(path.join(dir, name)));
}

function childRepos(dir: string): { name: string; path: string; branch: string }[] {
  return repoEntries(dir);
}

function siblingRepos(gitRoot: string): { name: string; path: string; branch: string }[] {
  return repoEntries(path.dirname(gitRoot)).filter((repo) => path.resolve(repo.path) !== path.resolve(gitRoot));
}

function repoEntries(dir: string): { name: string; path: string; branch: string }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { name: string; path: string; branch: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(abs, '.git'))) continue;
    found.push({ name: entry.name, path: abs, branch: currentBranch(abs) });
    if (found.length >= 30) break;
  }
  return found;
}

function readRemotes(dir: string): string[] {
  try {
    const text = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    return [...text.matchAll(/\[remote "([^"]+)"\]/g)].map((match) => match[1]);
  } catch {
    return [];
  }
}

function detectPlugins(cwd: string, home: string | undefined): InspectReport['plugins'] {
  const roots = [path.join(cwd, '.claude')];
  if (home) roots.push(path.join(home, '.claude'));
  const blob = roots.map((root) => sniff(root)).join('\n').toLowerCase();
  return {
    superpowers: blob.includes('superpowers') || commandExists('superpowers'),
    graphify: blob.includes('graphify') || commandExists('graphify'),
    gitnexus: blob.includes('gitnexus') || commandExists('gitnexus'),
    claudeMem: blob.includes('claude-mem') || blob.includes('claudemem'),
  };
}

function sniff(root: string): string {
  if (!fs.existsSync(root)) return '';
  const names: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 300) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen++;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      names.push(entry.name);
      if (entry.isDirectory()) {
        const depth = dir.split(path.sep).length - root.split(path.sep).length;
        if (depth < 3) stack.push(path.join(dir, entry.name));
      }
    }
  }
  return names.join('\n');
}
