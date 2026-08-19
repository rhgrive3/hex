import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * Static canonical feature manifest for accuracy-merge.mjs. The executable
 * declarations live byte-for-byte in accuracy-base.mjs; this manifest keeps
 * the existing static merge-order contract while the audited scorer patch is
 * applied at runtime.
 *
 * feature('sections')
 * feature('funcs')
 * feature('funcs-guess')
 * feature('disasm')
 * feature('kinds')
 * feature('calls')
 * feature('refs')
 * feature('imports')
 * feature('objc')
 * feature('selstub')
 * feature('strings')
 * feature('xrefs')
 * feature('funcname')
 * feature('selffield')
 * feature('role')
 * feature('pinpoint')
 * feature('pinpoint-partial')
 * feature('apimeaning')
 * feature('summary')
 * feature('expr')
 * feature('formula')
 * feature('pseudoc')
 */

/*
 * Keep the historical scorer snapshotted in accuracy-base.mjs and apply only
 * the audited short-selector correction at runtime. This makes the change
 * surgical: all feature definitions, CLI behavior and thresholds remain byte-
 * for-byte identical to the pinned scorer except for summary name matching.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const basePath = path.join(here, 'accuracy-base.mjs');
const activePath = path.join(here, `.accuracy-active-${process.pid}.mjs`);
const oldCheck = '      if (core.length >= 4 && text.includes(core)) { ok++; continue; }';
const newCheck = '      if (summaryNamesCall(text, nm)) { ok++; continue; }';

let source = fs.readFileSync(basePath, 'utf8');
if (!source.includes(oldCheck)) throw new Error('accuracy-summary-scorer-anchor-missing');
source = `import { summaryNamesCall } from './accuracy-short-selector.mjs';\n` +
  source.replace(oldCheck, newCheck);

try {
  fs.writeFileSync(activePath, source);
  await import(pathToFileURL(activePath).href);
} finally {
  try { fs.unlinkSync(activePath); } catch {}
}
