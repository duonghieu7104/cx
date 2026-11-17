#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (process.env.CX_SHIP_INNER === '1') {
  const output = process.env.CX_OUTPUT;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const verdict = process.env.CX_PHASE === 'review' ? '\nVERDICT: GO\n' : '';
    fs.writeFileSync(output, `# ${process.env.CX_PHASE}\n\nStubbed output for ${process.env.CX_TASK}.${verdict}`);
  }
  const worktree = process.env.CX_WORKTREE;
  if (worktree && fs.existsSync(worktree)) {
    fs.writeFileSync(path.join(worktree, 'CX_NOTE.txt'), `note ${process.env.CX_TASK}\n`);
  }
  if (process.env.CX_PHASE === 'review') process.stdout.write('VERDICT: GO\n');
  else process.stdout.write(`ok ${process.env.CX_PHASE}\n`);
  process.exit(0);
}

const index = args.indexOf('/ship-task');
if (index === -1 || !args[index + 1]) {
  process.stderr.write('stub claude expected /ship-task <task>\n');
  process.exit(1);
}
const task = args[index + 1];
const cli = process.env.CX_BIN;
if (!cli) {
  process.stderr.write('CX_BIN is not set\n');
  process.exit(1);
}
const result = spawnSync(process.execPath, [cli, 'ship', task, '--auto-plan'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status === null ? 1 : result.status);
