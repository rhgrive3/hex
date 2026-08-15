import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const toRel = (file) => path.relative(root, file).split(path.sep).join('/');
const isJs = (name) => /\.(?:m?js)$/.test(name);

const CURRENT_GENERIC_FILES = [
  'js/dataflow.js',
  'js/dataflow-ir.js',
  'js/dataflow-ir-compare.js',
  'js/dataflow-semantic.js',
  'js/semantic.js',
  'js/semantic-evidence.js',
  'js/interproc.js',
  'js/slice.js',
  'js/range-domain.js',
];

const FUTURE_GENERIC_DIRS = [
  'js/core/identity',
  'js/core/evidence',
  'js/semantics/ssa',
  'js/semantics/memoryssa',
  'js/analysis/alias',
  'js/analysis/dataflow',
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes:true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (isJs(entry.name)) out.push(full);
  }
  return out;
}

const genericEntries = [
  ...CURRENT_GENERIC_FILES.map((file) => path.join(root, file)).filter(fs.existsSync),
  ...FUTURE_GENERIC_DIRS.flatMap((dir) => walk(path.join(root, dir))),
];
const genericSet = new Set(genericEntries.map((file) => path.resolve(file)));
for (const dir of FUTURE_GENERIC_DIRS) {
  for (const file of walk(path.join(root, dir))) genericSet.add(path.resolve(file));
}

if (!genericEntries.length) throw new Error('invariant boundary checker found no generic analysis entrypoints');

function isGenericImporter(file) {
  const abs = path.resolve(file);
  if (genericSet.has(abs)) return true;
  const rel = toRel(abs);
  return FUTURE_GENERIC_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

function isArchitectureModule(file) {
  const rel = toRel(path.resolve(file));
  return rel.startsWith('js/architecture/') || rel.startsWith('js/targets/architecture/');
}

function isConcreteTargetDependency(rel) {
  return rel.startsWith('js/architecture/')
    || /^js\/targets\/architecture\/[^/]+\//.test(rel)
    || /^js\/targets\/abi\/[^/]+\//.test(rel)
    || rel.startsWith('js/abi/');
}

function isAbiImplementation(rel) {
  return rel.startsWith('js/targets/abi/') || rel.startsWith('js/abi/');
}

function resolveLocal(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || base;
}

const violations = [];
const boundaryPlugin = {
  name:'hex-invariant-import-boundaries',
  setup(ctx) {
    ctx.onResolve({ filter:/.*/ }, (args) => {
      if (!args.importer) return null;
      const resolved = resolveLocal(args.importer, args.path);
      if (!resolved) return null;
      const importerRel = toRel(args.importer);
      const targetRel = toRel(resolved);

      if (isGenericImporter(args.importer) && isConcreteTargetDependency(targetRel)) {
        violations.push({
          invariant:'INV-005', importer:importerRel, target:targetRel,
          reason:'generic analysis must not directly depend on a concrete architecture or ABI implementation',
        });
      }
      if (isArchitectureModule(args.importer) && isAbiImplementation(targetRel)) {
        violations.push({
          invariant:'INV-005', importer:importerRel, target:targetRel,
          reason:'architecture modules must not import ABI implementation modules',
        });
      }
      return null;
    });
  },
};

await build({
  entryPoints:genericEntries,
  bundle:true,
  write:false,
  format:'esm',
  platform:'neutral',
  packages:'external',
  logLevel:'silent',
  plugins:[boundaryPlugin],
});

if (violations.length) {
  for (const violation of violations) {
    console.error(`${violation.invariant}: ${violation.importer} -> ${violation.target}`);
    console.error(`  ${violation.reason}`);
  }
  process.exit(1);
}

console.log(`import-boundaries: PASS (${genericEntries.length} generic entrypoints checked)`);
