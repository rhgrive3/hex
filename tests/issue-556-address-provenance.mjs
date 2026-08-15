import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 0x1000n;
const TARGET = 0x1100n;

const ADRP_X8 = 0x90000008;
const ADRP_X19 = 0x90000013;
const NOP = 0xd503201f;
const RET = 0xd65f03c0;
const MOVZ_X8_0 = 0xd2800008;
const LDR_X0_X8_100 = 0xf9408100;
const LDR_X8_X8_100 = 0xf9408108;
const LDR_X0_X19_100 = 0xf9408260;
const ADD_X9_X8_100 = 0x91040109;
const LDR_X0_X9_0 = 0xf9400120;

function b(fromIndex, toIndex) {
  return (0x14000000 | ((toIndex - fromIndex) & 0x03ffffff)) >>> 0;
}
function bl(fromIndex, toIndex) {
  return (0x94000000 | ((toIndex - fromIndex) & 0x03ffffff)) >>> 0;
}
function cbzX0(fromIndex, toIndex) {
  return (0xb4000000 | (((toIndex - fromIndex) & 0x7ffff) << 5)) >>> 0;
}
function bytesOf(words) {
  const bytes = new Uint8Array(words.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i] >>> 0, true);
  return bytes;
}

function loadWorker() {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
    setTimeout, clearTimeout,
  });
  context.self = context;
  context.globalThis = context;
  context.self.postMessage = () => {};
  context.importScripts = () => {};
  for (const file of ['js/macho.js', 'js/words.js', 'js/address-provenance.js', 'js/worker-legacy.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context;
}

async function runFixture(words, { starts = [] } = {}) {
  const context = loadWorker();
  context.__bytes = bytesOf(words);
  context.__starts = starts;
  vm.runInContext(`
    blocks.clear();
    fileSize = BigInt(__bytes.length);
    file = {
      size: __bytes.length,
      slice(start, end) {
        const copy = __bytes.slice(Number(start), Number(end));
        return { arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) };
      },
    };
    const __region = {
      id: 'code', kind: 'section', name: '__text', section: '__text',
      fileOffset: 0n, vmAddr: 0x1000n, size: BigInt(__bytes.length),
      exec: true, zerofill: false,
    };
    regions = new Map([['code', __region]]);
    slices = [{ regions: [__region], functionStarts: Array.from(__starts, (x) => BigInt(x)) }];
    currentEpoch = 0;
  `, context);
  const scan = await vm.runInContext(`scanProgram({ regionId:'code', requestId:null, epoch:0 })`, context);
  const xrefs = await vm.runInContext(`findXrefs({ regionId:'code', target:0x1100n, limit:100, requestId:null, epoch:0 })`, context);
  const scanHits = Array.from(scan.refTo || []).filter((x) => BigInt(x) === TARGET).length;
  const xrefHits = (xrefs.results || []).filter((x) => x.kind !== 'branch').length;
  return { scan, xrefs, scanHits, xrefHits };
}

async function expectHits(label, words, want, options) {
  const result = await runFixture(words, options);
  assert.equal(result.scanHits, want, `${label}: scanProgram target refs`);
  assert.equal(result.xrefHits, want, `${label}: findXrefs target refs`);
  assert.equal(result.scan.cancelled, false, `${label}: scanProgram unexpectedly cancelled`);
  assert.equal(result.xrefs.cancelled, false, `${label}: findXrefs unexpectedly cancelled`);
  return result;
}

// Valid same-basic-block pair.
await expectHits('same block', [ADRP_X8, NOP, LDR_X0_X8_100], 1);

// Preserve the established 4096-instruction pairing window; the safety fix is
// control-flow identity, not an arbitrary recall regression to 8/16 instructions.
await expectHits('long same block', [ADRP_X8, ...Array(64).fill(NOP), LDR_X0_X8_100], 1);

// RET is a hard path boundary. Adjacent bytes cannot inherit register state.
await expectHits('RET boundary', [ADRP_X8, RET, LDR_X0_X8_100], 0);

// An unconditional branch has no fallthrough edge; the skipped instruction is
// unreachable from the ADRP path and must not become a data reference.
await expectHits('unconditional branch fallthrough', [ADRP_X8, b(1, 3), LDR_X0_X8_100, NOP], 0);

// Exact function starts are hard provenance roots even without RET/padding.
await expectHits('adjacent functions', [ADRP_X8, NOP, LDR_X0_X8_100], 0,
  { starts: [BASE, BASE + 8n] });

// A conditional branch ends one basic block, but pc+4 is a real fallthrough
// edge dominated by the ADRP. This is the required valid block-edge case.
await expectHits('conditional fallthrough edge',
  [ADRP_X8, cbzX0(1, 3), LDR_X0_X8_100, NOP], 1);

// The taken target is a separate block entry. Linear fallthrough state must not
// leak into it after another arm changes the register.
await expectHits('conditional target join',
  [ADRP_X8, cbzX0(1, 3), MOVZ_X8_0, LDR_X0_X8_100], 0);

// ADD transfers the address together with the same control-flow provenance.
await expectHits('ADD register transfer',
  [ADRP_X8, ADD_X9_X8_100, LDR_X0_X9_0], 2);

// A load overwrites its destination register. Reusing the pre-load ADRP for a
// second load from that same register would fabricate a second reference.
await expectHits('load overwrites base register',
  [ADRP_X8, LDR_X8_X8_100, LDR_X0_X8_100], 1);

// Calls obey AAPCS64: caller-saved x8 cannot be trusted across BL.
await expectHits('caller-saved across call',
  [ADRP_X8, bl(1, 3), LDR_X0_X8_100, RET], 0);

// Callee-saved x19 may legitimately carry the same address across a call.
await expectHits('callee-saved across call',
  [ADRP_X19, bl(1, 3), LDR_X0_X19_100, RET], 1);

console.log('issue #556 address provenance: PASS');
