import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = path.join(ROOT, 'tests/phase5/verification/source/p5-6-corpus.c');
const EXPECTED = Object.freeze({
  compiler: 'Ubuntu clang version 18.1.3',
  linker: 'LLD 18.1.3',
  host: 'x64',
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: options.encoding ?? 'utf8',
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', SOURCE_DATE_EPOCH: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    throw new Error(`command failed (${result.status}): ${executable} ${args.join(' ')}\n${stdout}\n${stderr}`);
  }
  return result;
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('/') ? fs.existsSync(candidate) : spawnSync('bash', ['-lc', `command -v ${candidate}`], { encoding:'utf8' }).status === 0) return candidate;
  }
  return null;
}

export function probeToolchain() {
  const clang = firstExecutable(['/usr/bin/clang-18', 'clang-18', '/usr/bin/clang', 'clang']);
  const lld = firstExecutable(['/usr/bin/ld.lld-18', 'ld.lld-18', '/usr/bin/ld.lld', 'ld.lld']);
  const lldLink = firstExecutable(['/usr/bin/lld-link-18', 'lld-link-18', '/usr/bin/lld-link', 'lld-link']);
  const objdump = firstExecutable(['/usr/bin/llvm-objdump-18', 'llvm-objdump-18', '/usr/bin/llvm-objdump', 'llvm-objdump']);
  const readobj = firstExecutable(['/usr/bin/llvm-readobj-18', 'llvm-readobj-18', '/usr/bin/llvm-readobj', 'llvm-readobj']);
  const compilerVersion = clang ? run(clang, ['--version']).stdout.trim() : null;
  const linkerVersion = lld ? run(lld, ['--version']).stdout.trim() : null;
  const lldLinkVersion = lldLink ? run(lldLink, ['--version']).stdout.trim() : null;
  const result = {
    clang, lld, lldLink, objdump, readobj,
    compilerVersion,
    linkerVersion,
    lldLinkVersion,
    host: process.arch,
    exactCompiler: Boolean(compilerVersion?.includes(EXPECTED.compiler)),
    exactLinker: Boolean(linkerVersion?.includes(EXPECTED.linker) && lldLinkVersion?.includes(EXPECTED.linker)),
    exactHost: process.arch === EXPECTED.host,
  };
  return Object.freeze({ ...result, exact: result.exactCompiler && result.exactLinker && result.exactHost && Boolean(objdump) && Boolean(readobj) });
}

function optimizationFlag(level) {
  if (!['O0', 'O2', 'Os'].includes(level)) throw new TypeError(`unsupported optimization: ${level}`);
  return `-${level}`;
}

function buildOne({ toolchain, target, optimization, outDir }) {
  const suffix = target.id === 'sysv-amd64-elf' ? '.elf' : '.exe';
  const output = path.join(outDir, `p5-6-${target.id}-${optimization}${suffix}`);
  const common = [
    `--target=${target.triple}`,
    '-std=c11',
    optimizationFlag(optimization),
    '-fno-stack-protector',
    '-fno-omit-frame-pointer',
    '-fno-pic',
    '-nostdlib',
    '-fuse-ld=lld',
    SOURCE,
    '-o', output,
  ];
  const targetFlags = target.id === 'sysv-amd64-elf'
    ? ['-Wl,--build-id=none', '-Wl,-e,p5_entry', '-Wl,-Ttext=0x401000']
    : ['-Wl,/entry:p5_entry', '-Wl,/subsystem:console', '-Wl,/nodefaultlib', '-Wl,/fixed', '-Wl,/base:0x140000000', '-Wl,/Brepro'];
  const flags = [...common, ...targetFlags];
  run(toolchain.clang, flags);
  const bytes = fs.readFileSync(output);
  const objdumpArgs = ['-d', '--print-imm-hex', '--show-all-symbols', output];
  const disassembly = run(toolchain.objdump, objdumpArgs).stdout;
  const readobjArgs = ['--file-headers', '--sections', '--symbols', output];
  const objectMetadata = run(toolchain.readobj, readobjArgs).stdout;
  return Object.freeze({
    id: `${target.id}-${optimization}`,
    target: target.id,
    targetTriple: target.triple,
    abiId: target.abiId,
    optimization,
    path: output,
    flags,
    sha256: sha256(bytes),
    size: bytes.length,
    bytes,
    disassembly,
    objectMetadata,
  });
}

export function buildVerificationCorpus({ outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-p5-6-corpus-')) } = {}) {
  const toolchain = probeToolchain();
  if (!toolchain.exact) {
    const error = new Error(`P5-6 exact frozen toolchain unavailable: ${JSON.stringify(toolchain)}`);
    error.code = 'P5_6_TOOLCHAIN_MISMATCH';
    throw error;
  }
  fs.mkdirSync(outDir, { recursive:true });
  const sourceBytes = fs.readFileSync(SOURCE);
  const targets = [
    { id:'sysv-amd64-elf', triple:'x86_64-unknown-linux-gnu', abiId:'sysv-amd64' },
    { id:'microsoft-x64-pe', triple:'x86_64-pc-windows-msvc', abiId:'microsoft-x64' },
  ];
  const fixtures = [];
  for (const target of targets) for (const optimization of ['O0','O2','Os']) fixtures.push(buildOne({ toolchain, target, optimization, outDir }));
  return Object.freeze({
    schemaVersion: 'phase5-p5-6-generated-corpus/v1',
    toolchain,
    source: { path:path.relative(ROOT, SOURCE).replaceAll('\\','/'), sha256:sha256(sourceBytes) },
    fixtures,
  });
}

function emit(result, { includeBase64 = false } = {}) {
  const publicResult = {
    schemaVersion: result.schemaVersion,
    toolchain: result.toolchain,
    source: result.source,
    fixtures: result.fixtures.map(({ bytes, disassembly, objectMetadata, path:fixturePath, ...fixture }) => ({
      ...fixture,
      path: path.basename(fixturePath),
      disassemblySha256: sha256(Buffer.from(disassembly)),
      objectMetadataSha256: sha256(Buffer.from(objectMetadata)),
    })),
  };
  console.log(`P5_6_CORPUS_PROVENANCE=${JSON.stringify(publicResult)}`);
  if (includeBase64) {
    for (const fixture of result.fixtures) {
      console.log(`P5_6_FIXTURE_B64:${fixture.id}:${fixture.bytes.toString('base64')}`);
      console.log(`P5_6_OBJDUMP_B64:${fixture.id}:${Buffer.from(fixture.disassembly).toString('base64')}`);
      console.log(`P5_6_READOBJ_B64:${fixture.id}:${Buffer.from(fixture.objectMetadata).toString('base64')}`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const probeOnly = process.argv.includes('--probe-only');
  const includeBase64 = process.argv.includes('--emit-base64');
  if (probeOnly) {
    const result = probeToolchain();
    console.log(`P5_6_TOOLCHAIN=${JSON.stringify(result)}`);
    if (!result.exact) process.exitCode = 2;
  } else {
    try {
      emit(buildVerificationCorpus(), { includeBase64 });
    } catch (error) {
      console.error(error?.stack ?? String(error));
      process.exitCode = error?.code === 'P5_6_TOOLCHAIN_MISMATCH' ? 2 : 1;
    }
  }
}
