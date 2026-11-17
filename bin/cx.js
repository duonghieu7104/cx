#!/usr/bin/env node
import { main } from '../dist/src/cli.js';

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
