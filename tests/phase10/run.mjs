import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export function discoverPhase10Tests(root = DIRECTORY) {
  const discovered = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) discovered.push(absolute);
    }
  }
  visit(root);
  return discovered.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function selectedGroup(argv) {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== '--group' || !/^[a-z0-9][a-z0-9/-]*$/.test(argv[1])) {
    throw new TypeError('usage: node tests/phase10/run.mjs [--group <relative-directory>]');
  }
  return argv[1].replace(/\/$/, '');
}

export function runPhase10Tests(argv = process.argv.slice(2), { root = DIRECTORY } = {}) {
  const all = discoverPhase10Tests(root);
  if (all.length === 0) throw new Error('phase10: no contract tests discovered');
  const group = selectedGroup(argv);
  const selected = group == null ? all : all.filter((file) => {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    return relative === `${group}.test.mjs` || relative.startsWith(`${group}/`);
  });
  if (selected.length === 0) throw new Error(`phase10: group has no discovered tests: ${group}`);
  for (const file of selected) process.stdout.write(`[phase10] ${path.relative(root, file).replaceAll('\\', '/')}\n`);
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...selected], {
    cwd: path.resolve(root, '../..'),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`phase10: test runner failed with status ${child.status ?? 'signal'}`);
  console.log(`phase10: PASS (${selected.length}/${all.length} discovered test files${group ? `, group ${group}` : ''})`);
  return Object.freeze({ selected: selected.length, total: all.length, group });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runPhase10Tests();
