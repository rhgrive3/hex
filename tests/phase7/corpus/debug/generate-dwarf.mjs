import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Regenerates the committed DWARF fixture from a real compiler.
 *
 * Running this needs a toolchain; consuming the fixture does not. That split is
 * deliberate: the corpus records what a real compiler actually emitted (§17.2),
 * while the tests stay hermetic so a missing compiler cannot silently turn a
 * mandatory lane green by skipping it.
 *
 * Usage: node tests/phase7/corpus/debug/generate-dwarf.mjs
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'dwarf-fixtures.json');

const SOURCE = `#include <stdint.h>
struct Point { int32_t x; int32_t y; };
typedef uint32_t handle_t;
static int32_t counter;
int32_t add_point(struct Point *p, handle_t h) { counter += p->x + p->y + (int32_t)h; return counter; }
double scale(double v) { return v * 2.0; }
`;

const SECTIONS = ['.debug_info', '.debug_abbrev', '.debug_str', '.debug_line_str', '.debug_str_offsets', '.note.gnu.build-id', '.gnu_debuglink'];

function sectionBytes(file, name, work) {
  const target = path.join(work, `${name.replace(/[^a-z0-9]/gi, '_')}.bin`);
  try {
    execFileSync('objcopy', ['--dump-section', `${name}=${target}`, file, '/dev/null'], { stdio: 'pipe' });
  } catch { return null; }
  if (!fs.existsSync(target)) return null;
  const bytes = fs.readFileSync(target);
  return bytes.length ? bytes.toString('base64') : null;
}

function buildIdOf(file) {
  const output = execFileSync('readelf', ['-n', file], { encoding: 'utf8' });
  const match = output.match(/Build ID:\s*([0-9a-f]+)/i);
  return match ? match[1] : null;
}

function variant(work, { name, dwarfVersion }) {
  const source = path.join(work, 'fixture.c');
  fs.writeFileSync(source, SOURCE);
  const shared = path.join(work, `${name}.so`);
  execFileSync('gcc', ['-g', `-gdwarf-${dwarfVersion}`, '-O0', '-shared', '-fPIC', '-Wl,--build-id', source, '-o', shared]);
  const sections = {};
  for (const section of SECTIONS) {
    const encoded = sectionBytes(shared, section, work);
    if (encoded) sections[section] = encoded;
  }
  return { name, dwarfVersion, compiler: execFileSync('gcc', ['--version'], { encoding: 'utf8' }).split('\n')[0], buildId: buildIdOf(shared), sections };
}

function splitDebugVariant(work) {
  const source = path.join(work, 'fixture.c');
  fs.writeFileSync(source, SOURCE);
  const shared = path.join(work, 'split.so');
  execFileSync('gcc', ['-g', '-gdwarf-5', '-O0', '-shared', '-fPIC', '-Wl,--build-id', source, '-o', shared]);
  const debugFile = path.join(work, 'split.debug');
  execFileSync('objcopy', ['--only-keep-debug', shared, debugFile]);
  const stripped = path.join(work, 'split.stripped.so');
  execFileSync('objcopy', ['--strip-debug', `--add-gnu-debuglink=${debugFile}`, shared, stripped]);
  const sections = {};
  for (const section of SECTIONS) {
    const encoded = sectionBytes(debugFile, section, work);
    if (encoded) sections[section] = encoded;
  }
  const linkSection = sectionBytes(stripped, '.gnu_debuglink', work);
  return {
    name: 'split-debug',
    dwarfVersion: 5,
    buildId: buildIdOf(shared),
    sections,
    strippedDebugLink: linkSection,
    companion: fs.readFileSync(debugFile).toString('base64'),
  };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-dwarf-'));
try {
  const fixture = {
    schemaVersion: 1,
    generator: 'tests/phase7/corpus/debug/generate-dwarf.mjs',
    variants: [
      variant(work, { name: 'dwarf4', dwarfVersion: 4 }),
      variant(work, { name: 'dwarf5', dwarfVersion: 5 }),
      splitDebugVariant(work),
    ],
  };
  fs.writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes)`);
  for (const item of fixture.variants) {
    console.log(`  ${item.name}: buildId ${item.buildId}, sections ${Object.keys(item.sections).join(', ')}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
