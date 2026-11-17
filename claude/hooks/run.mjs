#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BAKED = '__CX_CLI__';

export function runHook(which) {
  const input = readFileSync(0, 'utf8');
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = process.env.CX_BIN || (String(BAKED).startsWith('__') ? resolve(here, '../../dist/src/cli.js') : BAKED);
  const result = spawnSync(process.execPath, [cli, 'hook', which], {
    input,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status === null ? 1 : result.status);
}
