import fs from 'node:fs';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const oraclePath = opt('oracle');
const hexPath = opt('hex');
const ghidraPath = opt('ghidra');
const outPath = opt('out');
const target = opt('target') || 'unknown';
if (!oraclePath || !hexPath || !ghidraPath || !outPath) {
  console.error('usage: node score.mjs --target=... --oracle=... --hex=... --ghidra=... --out=...');
  process.exit(2);
}

const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
const hex = JSON.parse(fs.readFileSync(hexPath, 'utf8'));
const truthFunctions = new Set(oracle.functionStarts.map(Number));
const truthCalls = new Set(oracle.calls.map(([a, b]) => `${Number(a)}:${Number(b)}`));
const textLo = Number(oracle.text.vm);
const textHi = textLo + Number(oracle.text.size);

function scoreSet(have, truth) {
  let tp = 0;
  let fp = 0;
  for (const key of have) {
    if (truth.has(key)) tp++;
    else fp++;
  }
  const fn = truth.size - tp;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

const ghidraFunctions = new Set();
const ghidraCalls = new Set();
const ghidraDecomp = [];
for (const raw of fs.readFileSync(ghidraPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line) continue;
  const p = line.split(/\s+/);
  if (p[0] === 'F' && p.length >= 2) {
    const a = Number.parseInt(p[1], 16);
    if (a >= textLo && a < textHi) ghidraFunctions.add(a);
  } else if (p[0] === 'C' && p.length >= 3) {
    const from = Number.parseInt(p[1], 16);
    const to = Number.parseInt(p[2], 16);
    if (from >= textLo && from < textHi) ghidraCalls.add(`${from}:${to}`);
  } else if (p[0] === 'D' && p.length >= 7) {
    ghidraDecomp.push({
      addr: Number.parseInt(p[1], 16),
      status: p[2],
      lines: Number(p[3]) || 0,
      gotos: Number(p[4]) || 0,
      casts: Number(p[5]) || 0,
      temporaries: Number(p[6]) || 0,
    });
  }
}
if (!ghidraFunctions.size) throw new Error('Ghidra produced no functions in __text');
if (!ghidraCalls.size) throw new Error('Ghidra produced no direct call references in __text');

const ghidraFunctionScore = scoreSet(ghidraFunctions, truthFunctions);
const ghidraCallScore = scoreSet(ghidraCalls, truthCalls);
const gdOk = ghidraDecomp.filter((x) => x.status === 'ok');
const sum = (xs, key) => xs.reduce((n, x) => n + x[key], 0);
const ghidraDecompile = {
  attempted: ghidraDecomp.length,
  success: gdOk.length,
  successRate: ghidraDecomp.length ? gdOk.length / ghidraDecomp.length : 0,
  missedFunctions: ghidraDecomp.filter((x) => x.status === 'miss').length,
  failedDecompiler: ghidraDecomp.filter((x) => x.status === 'fail').length,
  totalLines: sum(gdOk, 'lines'),
  gotos: sum(gdOk, 'gotos'),
  casts: sum(gdOk, 'casts'),
  temporaries: sum(gdOk, 'temporaries'),
};

const macro = (a, b) => (a + b) / 2;
const hexMacro = macro(hex.structural.functionGuess.f1, hex.structural.calls.f1);
const ghidraMacro = macro(ghidraFunctionScore.f1, ghidraCallScore.f1);
const winner = (a, b) => Math.abs(a - b) < 1e-12 ? 'tie' : a > b ? 'hex' : 'ghidra';

const result = {
  schema: 1,
  target,
  policy: {
    oracle: 'Mach-O LC_FUNCTION_STARTS + independent Capstone direct BL edges',
    functionDiscovery: 'LC_FUNCTION_STARTS datasize zeroed only in the Ghidra input copy; Hex uses guessFunctions without the table',
    calls: 'same original binary and same oracle source->target edges',
    decompile: 'same deterministic 80-function oracle sample; coverage/readability only, not semantic truth',
  },
  truth: { functionStarts: truthFunctions.size, directCalls: truthCalls.size },
  hex: {
    functions: hex.structural.functionGuess,
    calls: hex.structural.calls,
    structuralMacroF1: hexMacro,
    decompile: hex.decompile,
  },
  ghidra: {
    functions: ghidraFunctionScore,
    calls: ghidraCallScore,
    structuralMacroF1: ghidraMacro,
    decompile: ghidraDecompile,
  },
  winners: {
    functionsF1: winner(hex.structural.functionGuess.f1, ghidraFunctionScore.f1),
    callsF1: winner(hex.structural.calls.f1, ghidraCallScore.f1),
    structuralMacroF1: winner(hexMacro, ghidraMacro),
    decompileSuccessRate: winner(hex.decompile.successRate, ghidraDecompile.successRate),
  },
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
