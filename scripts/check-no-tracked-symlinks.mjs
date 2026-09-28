#!/usr/bin/env node
// Fail if git tracks any symlink (mode 120000).
//
// Worktree setups sometimes point `tiles` at the main checkout with a
// symlink. Committing that link (#4950, #5162) gave every fresh clone a
// dangling `tiles` and crash-looped the dev tileserver, which bind-mounts
// ./tiles. The repo has no legitimate tracked symlinks, so reject them all.
import { execFileSync } from 'node:child_process';

let out;
try {
  out = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  console.warn(`Tracked-symlink check skipped: git ls-files failed (${String(err.message).split('\n')[0]}).`);
  process.exit(0);
}

const links = out
  .split('\n')
  .filter(line => line.startsWith('120000 '))
  .map(line => line.split('\t')[1]);

if (links.length) {
  console.error('Tracked symlinks found. Keep worktree links local and untracked (git rm --cached <path>):');
  for (const link of links) console.error(`  ${link}`);
  process.exit(1);
}

console.log('Tracked-symlink check passed.');
