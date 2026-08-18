import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(relative) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative.replaceAll('\\','/')];
  return fs.readdirSync(absolute, { withFileTypes:true }).flatMap((entry) => walk(path.join(relative, entry.name)));
}

function sourceFiles(roots) {
  return roots.flatMap(walk).filter((file) => /\.(?:m?js)$/.test(file));
}

function executableLine(raw) {
  const line = raw.replace(/\/\/.*$/, '').trim();
  return line && !line.startsWith('*') && !line.startsWith('/*') ? line : '';
}

const x86Register = /['"](?:r(?:ax|bx|cx|dx|si|di|bp|sp|8|9|10|11|12|13|14|15)|e(?:ax|bx|cx|dx|si|di|bp|sp)|[abcd][lh]|xmm\d+|ymm\d+|mxcsr|rflags|cf|zf|sf|of|pf|af)['"]/i;
const x86Mnemonic = /['"](?:adc|sbb|cmpxchg|xadd|movzx|movsx|movsxd|set[a-z]+|cmov[a-z]+|ucomiss|ucomisd|addss|addsd|movaps|movups|vxorps|vzeroupper)['"]/i;
const branchContext = /(?:===|!==|==|!=|\bcase\b|\bswitch\b|\.includes\s*\(|\.has\s*\(|\.get\s*\()/;

test('generic semantic/analysis/decompiler code contains no x86-specific semantic branch', () => {
  const genericRoots = ['js/semantics', 'js/analysis', 'js/decompiler', 'js/core'];
  const findings = [];
  for (const file of sourceFiles(genericRoots)) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    lines.forEach((raw, index) => {
      const line = executableLine(raw);
      if (!line || !branchContext.test(line)) return;
      if (x86Register.test(line) || x86Mnemonic.test(line)) findings.push({ file, line:index + 1, source:line.slice(0, 300) });
    });
  }
  console.log(`P5_6_GENERIC_ARCHITECTURE_LEAK_AUDIT=${JSON.stringify({ scannedFiles:sourceFiles(genericRoots).length, count:findings.length, findings })}`);
  assert.equal(findings.length, 0, `generic x86-specific semantic leak: ${JSON.stringify(findings[0])}`);
});

test('formatted opStr is not parsed as x86 semantic authority', () => {
  const roots = ['js/targets/architecture/x86_64/effects', 'js/semantics'];
  const semanticParse = /opStr\s*(?:\.|\?\.)\s*(?:split|match|matchAll|includes|startsWith|endsWith|indexOf|replace|slice|substring)\s*\(|(?:RegExp|new\s+RegExp)\s*\([^\n]*opStr|\bopStr\b[^\n]*(?:===|!==|==|!=)/;
  const findings = [];
  for (const file of sourceFiles(roots)) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    lines.forEach((raw, index) => {
      const line = executableLine(raw);
      if (line && semanticParse.test(line)) findings.push({ file, line:index + 1, source:line.slice(0, 300) });
    });
  }
  console.log(`P5_6_OPSTR_AUTHORITY_AUDIT=${JSON.stringify({ scannedFiles:sourceFiles(roots).length, count:findings.length, findings })}`);
  assert.equal(findings.length, 0, `opStr semantic authority detected: ${JSON.stringify(findings[0])}`);
});
