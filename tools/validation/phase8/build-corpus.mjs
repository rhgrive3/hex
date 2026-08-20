/**
 * Canonical builder for the frozen Phase 8 corpus.
 *
 * One architecture-neutral source set is compiled for every mandatory Phase 8
 * architecture at the same optimization levels. ARM64 retains the historical
 * frozen assembly representation used by the public decompile facade. The
 * x86-64 and RISC-V64 lanes freeze relocation-resolved bytes from a final ELF
 * link and are decoded later by Hex's shipped Capstone artifact before entering
 * the shared semantic product path. Architecture labels are therefore never
 * substituted for real machine code, and unresolved ET_REL branch placeholders
 * are never mistaken for executable branch displacements.
 *
 * Re-running this builder deliberately changes corpus identity and invalidates
 * the baseline. The baseline must then be captured from the Phase 8 base product
 * with this measurement tooling only; never from the candidate implementation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_DIRECTORY = path.join(ROOT, 'tests/phase8/corpus/sources');
const TARGET = path.join(ROOT, 'tests/phase8/corpus/functions.json');

export const CORPUS_ID = 'phase8-decompiler-quality-corpus';
export const CORPUS_VERSION = 2;
export const OPTIMIZATION_LEVELS = Object.freeze(['-O0', '-O1', '-O2']);
export const ARCHITECTURES = Object.freeze([
  Object.freeze({ architectureId:'arm64', targetTriple:'aarch64-unknown-linux-gnu', representation:'assembly', compilerArgs:Object.freeze([]) }),
  Object.freeze({ architectureId:'x86_64', targetTriple:'x86_64-unknown-linux-gnu', representation:'machine-bytes', compilerArgs:Object.freeze([]) }),
  // Keep the first RISC-V measurement lane on the exact RV64IM subset supported
  // by the Phase 6 lifter. Compressed decoding remains independently covered by
  // Phase 6; no architecture identity is relabelled or downgraded here.
  Object.freeze({ architectureId:'riscv64', targetTriple:'riscv64-unknown-linux-gnu', representation:'machine-bytes', compilerArgs:Object.freeze(['-march=rv64im', '-mabi=lp64']) }),
]);

// The corpus deliberately contains an unknown-call barrier. Machine-byte lanes
// must still contain executable, relocation-resolved call bytes, so final links
// get a separate architecture-neutral definition of that external. It remains
// opaque to the function under test: the public product only decompiles the
// selected STT_FUNC bytes and does not inline or import this companion body.
const LINK_SUPPORT_SOURCE = '__attribute__((noinline,used)) void opaque(void) { __asm__ __volatile__("" ::: "memory"); }\n';

function codeText(line) { return String(line || '').replace(/\/\/.*$/, '').trim(); }

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

export function declaredFunctions(source) {
  const names = [];
  for (const match of source.matchAll(/^\s*(?:[A-Za-z_][\w ]*?[ *])([a-z][a-z0-9_]*)\s*\([^;]*?\)\s*\{/gm)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function clangIdentity(clang) {
  const version = spawnSync(clang, ['--version'], { encoding:'utf8' });
  if (version.status !== 0) return null;
  return String(version.stdout || '').split(/\r?\n/)[0].trim();
}

function safeNumber(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`phase8 corpus: ${code}`);
  return number;
}

function elf64SectionHeaders(buffer) {
  if (buffer.length < 64 || buffer[0] !== 0x7f || buffer.toString('ascii', 1, 4) !== 'ELF') throw new Error('phase8 corpus: compiler output is not ELF');
  if (buffer[4] !== 2 || buffer[5] !== 1) throw new Error('phase8 corpus: expected ELF64 little-endian object');
  const offset = safeNumber(buffer.readBigUInt64LE(0x28), 'invalid ELF section-table offset');
  const entrySize = buffer.readUInt16LE(0x3a);
  const count = buffer.readUInt16LE(0x3c);
  if (entrySize < 64 || count === 0 || offset + entrySize * count > buffer.length) throw new Error('phase8 corpus: invalid ELF section table');
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * entrySize;
    sections.push({
      index,
      type:buffer.readUInt32LE(at + 4),
      address:buffer.readBigUInt64LE(at + 16),
      offset:safeNumber(buffer.readBigUInt64LE(at + 24), 'invalid ELF section offset'),
      size:safeNumber(buffer.readBigUInt64LE(at + 32), 'invalid ELF section size'),
      link:buffer.readUInt32LE(at + 40),
      entrySize:safeNumber(buffer.readBigUInt64LE(at + 56), 'invalid ELF section entry size'),
    });
  }
  for (const section of sections) if (section.offset + section.size > buffer.length) throw new Error('phase8 corpus: ELF section exceeds object');
  return sections;
}

function cString(buffer, offset, limit) {
  if (offset < 0 || offset >= limit) return '';
  let end = offset;
  while (end < limit && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', offset, end);
}

/**
 * Extract exact STT_FUNC bytes from an ELF64 file.
 *
 * ET_REL symbols use section-relative st_value. Final linked ELF files use a
 * virtual st_value, so the section virtual address is subtracted before mapping
 * to file bytes. Phase 8 machine-byte lanes intentionally use the latter: local
 * branch/jump relocations must already be applied before bytes become evidence.
 */
export function extractElfFunctionBytes(buffer, name) {
  const sections = elf64SectionHeaders(buffer);
  const elfType = buffer.readUInt16LE(0x10);
  const symbolTable = sections.find((section) => section.type === 2 && section.entrySize >= 24);
  if (!symbolTable) throw new Error('phase8 corpus: ELF symbol table missing');
  const strings = sections[symbolTable.link];
  if (!strings) throw new Error('phase8 corpus: ELF symbol string table missing');
  for (let at = symbolTable.offset; at + 24 <= symbolTable.offset + symbolTable.size; at += symbolTable.entrySize) {
    const nameOffset = buffer.readUInt32LE(at);
    const info = buffer[at + 4];
    const sectionIndex = buffer.readUInt16LE(at + 6);
    if ((info & 0x0f) !== 2) continue;
    const symbolName = cString(buffer, strings.offset + nameOffset, strings.offset + strings.size);
    if (symbolName !== name) continue;
    const section = sections[sectionIndex];
    if (!section) throw new Error(`phase8 corpus: function ${name} has invalid section index`);
    const symbolValue = buffer.readBigUInt64LE(at + 8);
    const sectionRelativeValue = elfType === 1 ? symbolValue : symbolValue - section.address;
    const value = safeNumber(sectionRelativeValue, `function ${name} offset is invalid`);
    const size = safeNumber(buffer.readBigUInt64LE(at + 16), `function ${name} size is invalid`);
    if (size <= 0 || value + size > section.size) throw new Error(`phase8 corpus: function ${name} has invalid/empty extent`);
    return Uint8Array.from(buffer.subarray(section.offset + value, section.offset + value + size));
  }
  return null;
}

function compileAssembly(clang, architecture, optimization, sourcePath) {
  const compiled = spawnSync(clang, [
    `--target=${architecture.targetTriple}`,
    ...architecture.compilerArgs,
    optimization,
    '-S',
    '-fno-asynchronous-unwind-tables',
    '-o', '-', sourcePath,
  ], { encoding:'utf8', maxBuffer:32 * 1024 * 1024 });
  if (compiled.status !== 0) throw new Error(`phase8 corpus: clang assembly failed for ${architecture.architectureId} ${optimization}: ${String(compiled.stderr).trim().slice(0, 300)}`);
  return compiled.stdout;
}

function compileObject(clang, architecture, optimization, sourcePath, outputPath) {
  const compiled = spawnSync(clang, [
    `--target=${architecture.targetTriple}`,
    ...architecture.compilerArgs,
    optimization,
    '-c',
    '-fno-asynchronous-unwind-tables',
    '-o', outputPath, sourcePath,
  ], { encoding:'utf8', maxBuffer:32 * 1024 * 1024 });
  if (compiled.status !== 0) throw new Error(`phase8 corpus: clang object failed for ${architecture.architectureId} ${optimization}: ${String(compiled.stderr).trim().slice(0, 300)}`);
  return outputPath;
}

function compileLinkSupport(clang, architecture, optimization, directory) {
  const sourcePath = path.join(directory, `${architecture.architectureId}-link-support.c`);
  const outputPath = path.join(directory, `${architecture.architectureId}-${optimization.slice(1)}-link-support.o`);
  if (!fs.existsSync(sourcePath)) fs.writeFileSync(sourcePath, LINK_SUPPORT_SOURCE);
  return compileObject(clang, architecture, optimization, sourcePath, outputPath);
}

function linkObjects(clang, architecture, optimization, objectPaths, outputPath) {
  const linked = spawnSync(clang, [
    `--target=${architecture.targetTriple}`,
    ...architecture.compilerArgs,
    '-fuse-ld=lld',
    '-nostdlib',
    '-no-pie',
    '-Wl,--build-id=none',
    '-Wl,-e,0',
    '-o', outputPath, ...objectPaths,
  ], { encoding:'utf8', maxBuffer:32 * 1024 * 1024 });
  if (linked.status !== 0) throw new Error(`phase8 corpus: final link failed for ${architecture.architectureId} ${optimization}: ${String(linked.stderr).trim().slice(0, 300)}`);
  const result = fs.readFileSync(outputPath);
  if (result.readUInt16LE(0x10) === 1) throw new Error(`phase8 corpus: ${architecture.architectureId} final link remained relocatable`);
  return result;
}

function entryId(sourceName, functionName, optimization, architectureId) {
  const legacy = `${path.basename(sourceName, '.c')}.${functionName}.${optimization.slice(1)}`;
  return architectureId === 'arm64' ? legacy : `${architectureId}.${legacy}`;
}

export function buildCorpus({ clang = process.env.CLANG || 'clang' } = {}) {
  const identity = clangIdentity(clang);
  if (!identity) throw new Error(`phase8 corpus: ${clang} is unavailable; the frozen corpus cannot be rebuilt without it`);
  const sources = fs.readdirSync(SOURCE_DIRECTORY).filter((name) => name.endsWith('.c')).sort();
  if (sources.length === 0) throw new Error('phase8 corpus: no sources found');

  const functions = [];
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase8-corpus-'));
  try {
    for (const sourceName of sources) {
      const sourcePath = path.join(SOURCE_DIRECTORY, sourceName);
      const sourceText = fs.readFileSync(sourcePath, 'utf8');
      const names = declaredFunctions(sourceText);
      if (names.length === 0) throw new Error(`phase8 corpus: no functions declared in ${sourceName}`);
      for (const architecture of ARCHITECTURES) {
        for (const optimization of OPTIMIZATION_LEVELS) {
          if (architecture.representation === 'assembly') {
            const listing = compileAssembly(clang, architecture, optimization, sourcePath);
            for (const name of names) {
              const assembly = extractFunction(listing, name);
              if (!assembly) throw new Error(`phase8 corpus: function not found in assembly: ${architecture.architectureId} ${name} ${optimization}`);
              functions.push({
                id:entryId(sourceName, name, optimization, architecture.architectureId),
                source:sourceName,
                function:name,
                optimization,
                architectureId:architecture.architectureId,
                targetTriple:architecture.targetTriple,
                representation:'assembly',
                assembly,
              });
            }
          } else {
            const stem = `${architecture.architectureId}-${path.basename(sourceName)}-${optimization.slice(1)}`;
            const objectPath = path.join(temporaryDirectory, `${stem}.o`);
            const linkedPath = path.join(temporaryDirectory, `${stem}.elf`);
            compileObject(clang, architecture, optimization, sourcePath, objectPath);
            const supportObject = compileLinkSupport(clang, architecture, optimization, temporaryDirectory);
            const linked = linkObjects(clang, architecture, optimization, [objectPath, supportObject], linkedPath);
            for (const name of names) {
              const bytes = extractElfFunctionBytes(linked, name);
              if (!bytes) throw new Error(`phase8 corpus: function not found in linked ELF: ${architecture.architectureId} ${name} ${optimization}`);
              functions.push({
                id:entryId(sourceName, name, optimization, architecture.architectureId),
                source:sourceName,
                function:name,
                optimization,
                architectureId:architecture.architectureId,
                targetTriple:architecture.targetTriple,
                representation:'machine-bytes',
                bytes:Buffer.from(bytes).toString('hex'),
              });
            }
          }
        }
      }
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive:true, force:true });
  }

  functions.sort((left, right) => left.id.localeCompare(right.id));
  const corpus = {
    schemaVersion:2,
    corpusId:CORPUS_ID,
    corpusVersion:CORPUS_VERSION,
    toolchain:{
      compiler:identity,
      targets:ARCHITECTURES.map((architecture) => ({
        architectureId:architecture.architectureId,
        target:architecture.targetTriple,
        compilerArgs:[...architecture.compilerArgs],
      })),
      optimizationLevels:[...OPTIMIZATION_LEVELS],
    },
    sourceDigest:stableDigest(sources.map((name) => ({ name, text:fs.readFileSync(path.join(SOURCE_DIRECTORY, name), 'utf8') }))),
    functions,
  };
  corpus.corpusDigest = stableDigest({ ...corpus, corpusDigest:undefined });
  return corpus;
}

export function loadCorpus(target = TARGET) {
  if (!fs.existsSync(target)) throw new Error(`phase8 corpus: frozen corpus is missing at ${path.relative(ROOT, target)}; run node tools/validation/phase8/build-corpus.mjs`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const corpus = buildCorpus();
  fs.mkdirSync(path.dirname(TARGET), { recursive:true });
  const temporary = `${TARGET}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(corpus, null, 2)}\n`);
  fs.renameSync(temporary, TARGET);
  const counts = Object.fromEntries(ARCHITECTURES.map((architecture) => [architecture.architectureId, corpus.functions.filter((entry) => entry.architectureId === architecture.architectureId).length]));
  console.log(`phase8 corpus: ${corpus.functions.length} functions, digest ${corpus.corpusDigest}`);
  console.log(`architectures: ${JSON.stringify(counts)}`);
  console.log(`toolchain: ${corpus.toolchain.compiler}`);
}