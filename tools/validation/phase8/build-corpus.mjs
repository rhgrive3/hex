/**
 * Canonical builder for the frozen Phase 8 corpus.
 *
 * It compiles `tests/phase8/corpus/sources/*.c` for AArch64 at several
 * optimization levels and freezes the resulting assembly, together with the
 * exact toolchain identity, into `tests/phase8/corpus/functions.json`.
 *
 * The corpus is frozen rather than recompiled per run because a corpus that is
 * regenerated on every machine is a different question set on every machine, and
 * a baseline compared across two question sets proves nothing (EP-011, §5).
 * Re-running this builder is therefore a deliberate act: it changes the corpus
 * digest, which invalidates the baseline and every metric derived from it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIRECTORY = path.join(ROOT, 'tests/phase8/corpus/sources');
const TARGET = path.join(ROOT, 'tests/phase8/corpus/functions.json');

export const CORPUS_ID = 'phase8-decompiler-quality-corpus';
export const CORPUS_VERSION = 1;
export const OPTIMIZATION_LEVELS = Object.freeze(['-O0', '-O1', '-O2']);
export const TARGET_TRIPLE = 'aarch64-unknown-linux-gnu';

function codeText(line) { return String(line || '').replace(/\/\/.*$/, '').trim(); }

/**
 * Extracts one function's assembly body from a clang `-S` listing.
 *
 * Directives, comments and alignment padding are dropped; labels are kept as
 * they carry the control flow the decompiler has to recover.
 */
export function extractFunction(assembly, name) {
  const all = assembly.split(/\r?\n/);
  const start = all.findIndex((line) => codeText(line) === `${name}:`);
  if (start < 0) return null;
  let end = all.length;
  for (let index = start + 1; index < all.length; index += 1) {
    const code = codeText(all[index]);
    if (/^\.Lfunc_end\d+:/.test(code) || (/^[A-Za-z_$][\w$]*:\s*$/.test(code) && !/^\.L/.test(code))) { end = index; break; }
  }
  const kept = [];
  for (let index = start + 1; index < end; index += 1) {
    const text = codeText(all[index]);
    if (!text) continue;
    if (/^(\.L[\w.$]+):/.test(text)) { kept.push(text); continue; }
    if (text.startsWith('.') || text.startsWith('//') || text.startsWith('#')) continue;
    kept.push(text);
  }
  return kept.length ? kept.join('\n') : null;
}

/** Function names the corpus declares, read from the source rather than a list. */
export function declaredFunctions(source) {
  const names = [];
  for (const match of source.matchAll(/^\s*(?:[A-Za-z_][\w ]*?[ *])([a-z][a-z0-9_]*)\s*\([^;]*?\)\s*\{/gm)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function clangIdentity(clang) {
  const version = spawnSync(clang, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) return null;
  return String(version.stdout || '').split(/\r?\n/)[0].trim();
}

export function buildCorpus({ clang = process.env.CLANG || 'clang' } = {}) {
  const identity = clangIdentity(clang);
  if (!identity) throw new Error(`phase8 corpus: ${clang} is unavailable; the frozen corpus cannot be rebuilt without it`);

  const sources = fs.readdirSync(SOURCE_DIRECTORY).filter((name) => name.endsWith('.c')).sort();
  if (sources.length === 0) throw new Error('phase8 corpus: no sources found');

  const functions = [];
  for (const sourceName of sources) {
    const sourcePath = path.join(SOURCE_DIRECTORY, sourceName);
    const sourceText = fs.readFileSync(sourcePath, 'utf8');
    const names = declaredFunctions(sourceText);
    if (names.length === 0) throw new Error(`phase8 corpus: no functions declared in ${sourceName}`);
    for (const optimization of OPTIMIZATION_LEVELS) {
      const compiled = spawnSync(clang, [
        `--target=${TARGET_TRIPLE}`, optimization, '-S', '-fno-asynchronous-unwind-tables', '-o', '-', sourcePath,
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (compiled.status !== 0) {
        throw new Error(`phase8 corpus: clang failed for ${sourceName} ${optimization}: ${String(compiled.stderr).trim().slice(0, 300)}`);
      }
      for (const name of names) {
        const assembly = extractFunction(compiled.stdout, name);
        if (!assembly) throw new Error(`phase8 corpus: function not found in output: ${name} ${optimization}`);
        functions.push({
          id: `${path.basename(sourceName, '.c')}.${name}.${optimization.slice(1)}`,
          source: sourceName,
          function: name,
          optimization,
          architectureId: 'arm64',
          assembly,
        });
      }
    }
  }
  functions.sort((left, right) => left.id.localeCompare(right.id));

  const corpus = {
    schemaVersion: 1,
    corpusId: CORPUS_ID,
    corpusVersion: CORPUS_VERSION,
    // Toolchain identity is part of the corpus, not a footnote: the same source
    // compiled by a different clang is different evidence (§3.5).
    toolchain: { compiler: identity, target: TARGET_TRIPLE, optimizationLevels: [...OPTIMIZATION_LEVELS] },
    sourceDigest: stableDigest(sources.map((name) => ({
      name, text: fs.readFileSync(path.join(SOURCE_DIRECTORY, name), 'utf8'),
    }))),
    functions,
  };
  corpus.corpusDigest = stableDigest({ ...corpus, corpusDigest: undefined });
  return corpus;
}

/** Loads the frozen corpus. Absence is an explicit error, never an empty run. */
export function loadCorpus(target = TARGET) {
  if (!fs.existsSync(target)) {
    throw new Error(`phase8 corpus: frozen corpus is missing at ${path.relative(ROOT, target)}; run node tools/validation/phase8/build-corpus.mjs`);
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const corpus = buildCorpus();
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  const temporary = `${TARGET}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(corpus, null, 2)}\n`);
  fs.renameSync(temporary, TARGET);
  console.log(`phase8 corpus: ${corpus.functions.length} functions, digest ${corpus.corpusDigest}`);
  console.log(`toolchain: ${corpus.toolchain.compiler} (${corpus.toolchain.target})`);
}
