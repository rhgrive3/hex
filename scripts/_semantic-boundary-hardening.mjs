import fs from 'node:fs';

function replaceOnce(path, oldText, newText) {
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes(oldText)) throw new Error(`missing expected snippet in ${path}: ${oldText.slice(0, 120)}`);
  source = source.replace(oldText, newText);
  fs.writeFileSync(path, source);
}

replaceOnce('js/analyze.js',
`const MAX_INSTRUCTIONS = 40000;
const MAX_MODEL_ROWS = 6000;
const MODEL_TEXTS = 96;`,
`const MAX_INSTRUCTIONS = 40000;
const MAX_MODEL_ROWS = 6000;
const MODEL_TEXTS = 96;
const ARM64_SEMANTIC_ARCHES = new Set(['arm64', 'arm64e', 'arm64_32']);

export function supportsArm64SemanticAnalysis(architecture) {
  return ARM64_SEMANTIC_ARCHES.has(String(architecture || '').toLowerCase());
}
function rowBudget(opts = {}) {
  const raw = Number(opts?.maxRows);
  if (!Number.isFinite(raw)) return MAX_INSTRUCTIONS;
  return Math.max(1, Math.min(MAX_INSTRUCTIONS, Math.floor(raw)));
}`);

replaceOnce('js/analyze.js',
`export async function analyzeFunction(backend, region, startRow, endRow, symbols, onProgress) {
  const rows = Math.min(endRow - startRow + 1, MAX_INSTRUCTIONS);
  const truncated = endRow - startRow + 1 > MAX_INSTRUCTIONS;
  const end = startRow + rows - 1;`,
`export async function analyzeFunction(backend, region, startRow, endRow, symbols, onProgress, opts = {}) {
  const requestedRows = Math.max(0, endRow - startRow + 1);
  const rows = Math.min(requestedRows, rowBudget(opts));
  if (rows <= 0) throw new Error('analysis-range-empty');
  const truncated = requestedRows > rows;
  const end = startRow + rows - 1;`);

replaceOnce('js/analyze.js',
`      if (rawInsns.length < MAX_MODEL_ROWS) rawInsns.push({ row, address: addr, mn, ops: opsStr });`,
`      if (rawInsns.length <= MAX_MODEL_ROWS) rawInsns.push({ row, address: addr, mn, ops: opsStr });`);

replaceOnce('js/analyze.js',
`  res.model = buildSemanticModel(rawInsns, {
    startRow, endRow: end, name,
    symbolFor: (a) => (symbols ? (symbols.nameAt(a) || null) : null),
    rowOfAddress: (a) => {
      if (a == null) return null;
      const rel = a - region.vmAddr;
      if (rel < 0n || rel >= region.size) return null;
      return Number(rel / 4n);
    },
  });
  return res;`,
`  res.model = buildSemanticModel(rawInsns, {
    startRow, endRow: end, name,
    symbolFor: (a) => (symbols ? (symbols.nameAt(a) || null) : null),
    rowOfAddress: (a) => {
      if (a == null) return null;
      const rel = a - region.vmAddr;
      if (rel < 0n || rel >= region.size) return null;
      return Number(rel / 4n);
    },
  });
  if (truncated && res.model) res.model.truncated = true;
  res.truncated = truncated || !!res.model?.truncated;
  res.requestedRows = requestedRows;
  res.analyzedRows = rows;
  return res;`);

replaceOnce('js/analyze.js',
`function cacheKey(region, startRow, endRow, symbols) {
  const symbolGen = symbols && symbols.gen != null ? symbols.gen : 0;
  const regionRevision = region?.revision ?? region?.gen ?? region?.generation ?? 0;
  return [symbolGen, region?.id, String(region?.vmAddr ?? ''), String(region?.size ?? ''), regionRevision, startRow, endRow].join(':');
}`,
`function cacheKey(region, startRow, endRow, symbols, maxRows = MAX_INSTRUCTIONS) {
  const symbolGen = symbols && symbols.gen != null ? symbols.gen : 0;
  const regionRevision = region?.revision ?? region?.gen ?? region?.generation ?? 0;
  return [symbolGen, region?.id, String(region?.vmAddr ?? ''), String(region?.size ?? ''), regionRevision, startRow, endRow, 'rows=' + maxRows].join(':');
}`);

replaceOnce('js/analyze.js',
`export async function analyzeFunctionCached(backend, region, startRow, endRow, symbols, onProgress, opts) {
  const key = cacheKey(region, startRow, endRow, symbols);
  const wantTexts = !opts || opts.texts !== false;`,
`export async function analyzeFunctionCached(backend, region, startRow, endRow, symbols, onProgress, opts = {}) {
  const budget = rowBudget(opts);
  const key = cacheKey(region, startRow, endRow, symbols, budget);
  const wantTexts = opts.texts !== false;`);

replaceOnce('js/analyze.js',
`  const res = await analyzeFunction(backend, region, startRow, endRow, symbols, onProgress);`,
`  const res = await analyzeFunction(backend, region, startRow, endRow, symbols, onProgress, { ...opts, maxRows: budget });`);

replaceOnce('js/ai/ui/hex-context.js',
`import { analyzeFunctionCached } from '../../analyze.js';`,
`import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../../analyze.js';`);

const oldAnalyzeModel = `export async function analyzeModelAt(app, address) {
  const addr = toBigInt(address);
  if (addr == null) return null;
  const region = regionForAddress(app, addr);
  if (!region || !app.store.get('canDisassemble')) return null;
  const sym = app.symbols;
  const fn = sym && sym.functionCount ? sym.functionAt(addr) : null;
  const start = fn ? fn.start : addr;
  if (!containsAddress(region, start)) return null;
  const step=BigInt(instructionBytes(app));
  if ((start-region.vmAddr)%step !== 0n) return null;
  const startRow = Number((start - region.vmAddr) / step);
  const totalRows = Number(region.size / step);
  const endRow = fn && fn.end != null
    ? Math.min(totalRows - 1, Number((fn.end - region.vmAddr) / step) - 1)
    : Math.min(totalRows - 1, startRow + 2048);
  if (endRow < startRow) return null;
  try {
    const res = await analyzeFunctionCached(app.backend, region, startRow, endRow, sym);
    return res && res.model ? res.model : null;
  } catch {
    return null;
  }
}`;
const newAnalyzeModel = `export async function analyzeModelAt(app, address, end = null, options = {}) {
  const addr = toBigInt(address);
  if (addr == null) return null;
  const architecture = app.store.get('architecture') || app.store.get('capability')?.architecture || null;
  if (!supportsArm64SemanticAnalysis(architecture)) return null;
  const region = regionForAddress(app, addr);
  if (!region || !app.store.get('canDisassemble')) return null;
  const sym = app.symbols;
  const fn = sym && sym.functionCount ? sym.functionAt(addr) : null;
  const start = fn ? fn.start : addr;
  if (!containsAddress(region, start)) return null;
  const step = BigInt(instructionBytes(app));
  if (step !== 4n || (start - region.vmAddr) % step !== 0n) return null;
  const startRow = Number((start - region.vmAddr) / step);
  const totalRows = Number(region.size / step);
  const regionEnd = region.vmAddr + region.size;
  const provenEnd = fn?.end == null ? null : toBigInt(fn.end);
  const requestedEnd = toBigInt(end);
  let boundedEnd = provenEnd;
  if (requestedEnd != null) boundedEnd = boundedEnd == null ? requestedEnd : (requestedEnd < boundedEnd ? requestedEnd : boundedEnd);
  if (boundedEnd == null) boundedEnd = start + 2048n * step;
  if (boundedEnd > regionEnd) boundedEnd = regionEnd;
  if (boundedEnd <= start) return null;
  const endRow = Math.min(totalRows - 1, Number((boundedEnd - region.vmAddr + step - 1n) / step) - 1);
  if (endRow < startRow) return null;
  const rawMax = Number(options?.maxInstructions);
  if (Number.isFinite(rawMax) && Math.floor(rawMax) <= 0) return null;
  const maxRows = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : undefined;
  const coversProvenEnd = provenEnd != null && provenEnd <= regionEnd && boundedEnd >= provenEnd;
  try {
    const res = await analyzeFunctionCached(app.backend, region, startRow, endRow, sym, null, { maxRows });
    const model = res?.model;
    if (!model) return null;
    const incomplete = !coversProvenEnd || res.truncated === true || model.truncated === true;
    return incomplete && model.truncated !== true ? { ...model, truncated: true } : model;
  } catch {
    return null;
  }
}`;
replaceOnce('js/ai/ui/hex-context.js', oldAnalyzeModel, newAnalyzeModel);
replaceOnce('js/ai/ui/hex-context.js',
`    analyze: (address) => analyzeModelAt(app, address),`,
`    analyze: (address, end, options) => analyzeModelAt(app, address, end, options),`);

replaceOnce('js/app.js',
`import { clearAnalysisCache, analyzeFunctionCached } from './analyze.js';`,
`import { clearAnalysisCache, analyzeFunctionCached, supportsArm64SemanticAnalysis } from './analyze.js';`);
replaceOnce('js/app.js',
`  async analyzeFunctionAt(addr) {
    const sym=this.symbols, range=this.validatedFunctionRange(addr);
    if(!range.ok || !this.store.get('canDisassemble') || !sym.functionCount) return null;`,
`  async analyzeFunctionAt(addr) {
    const sym=this.symbols, range=this.validatedFunctionRange(addr);
    const architecture=this.store.get('architecture')||this.store.get('capability')?.architecture||null;
    if(!supportsArm64SemanticAnalysis(architecture)||!range.ok||!this.store.get('canDisassemble')||!sym.functionCount)return null;`);

{
  const path = 'package.json';
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  const parts = data.scripts['ai:test'].split('&&').map((item) => item.trim());
  const command = 'node tests/ai-analysis-boundary.mjs';
  if (!parts.includes(command)) parts.unshift(command);
  data.scripts['ai:test'] = parts.join(' && ');
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
