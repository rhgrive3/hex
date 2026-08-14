import fs from 'node:fs';

const EPS = 1e-12;

/*
 * Cross-binary regression floors.
 *
 * The oracle is regenerated from each executable in CI, so these are not
 * golden-output snapshots. They are minimum acceptable qualities for the real
 * production pipeline when compared with independent LIEF + Capstone truth.
 * Keep the exact invariants exact; keep heuristic floors just below the
 * measured values so harmless implementation noise cannot hide a real drop.
 */
const TARGETS = [
  {
    name: 'BattleCats',
    file: 'accuracy-BattleCats.json',
    min: {
      sections: 1,
      funcs: 1,
      'funcs-guess': 0.982,
      disasm: 1,
      kinds: 0.998,
      calls: 1,
      refs: 0.9975,
      imports: 1,
      strings: 0.999,
      xrefs: 0.994,
      objc: 0.99,
      selstub: 0.999,
      role: 0.99,
      pinpoint: 1,
      'pinpoint-partial': 1,
      apimeaning: 0.99,
      summary: 0.99,
      pseudoc: 0.994,
    },
  },
  {
    name: 'YWP',
    file: 'accuracy-YWP.json',
    min: {
      sections: 1,
      funcs: 1,
      'funcs-guess': 0.970,
      disasm: 1,
      kinds: 0.998,
      calls: 1,
      refs: 0.9985,
      imports: 1,
      strings: 0.999,
      xrefs: 0.994,
      apimeaning: 0.99,
      pseudoc: 0.994,
    },
  },
  {
    name: 'TsumTsum',
    file: 'accuracy-TsumTsum.json',
    min: {
      sections: 1,
      funcs: 1,
      'funcs-guess': 0.9732,
      disasm: 1,
      kinds: 0.998,
      calls: 1,
      refs: 0.998,
      imports: 1,
      strings: 0.999,
      xrefs: 0.994,
      objc: 0.99,
      selstub: 0.999,
      role: 0.99,
      pinpoint: 1,
      'pinpoint-partial': 1,
      apimeaning: 0.99,
      summary: 0.99,
      pseudoc: 0.994,
    },
  },
];

let failed = false;

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.error(`FAIL ${target.name}: missing ${target.file}`);
    failed = true;
    continue;
  }

  const rows = JSON.parse(fs.readFileSync(target.file, 'utf8'));
  const byId = new Map(rows.map((row) => [row.id, row]));
  console.log(`\n${target.name}`);

  for (const [id, floor] of Object.entries(target.min)) {
    const row = byId.get(id);
    const score = row && typeof row.score === 'number' ? row.score : null;
    const ok = score != null && score + EPS >= floor;
    const actual = score == null ? 'N/A' : `${(score * 100).toFixed(3)}%`;
    const required = `${(floor * 100).toFixed(3)}%`;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${actual} (min ${required})`);
    if (!ok) failed = true;
  }
}

if (failed) {
  console.error('\nCross-binary accuracy gate failed. Inspect the uploaded accuracy-results artifact.');
  process.exit(1);
}

console.log('\nCross-binary accuracy gate passed.');
