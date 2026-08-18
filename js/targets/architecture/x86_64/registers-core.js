(function installHexX86Registers(root) {
  'use strict';

  const descriptors = new Map();
  const physical = new Map();

  function addPhysical(id, bits, kind, views) {
    const record = Object.freeze({ id, bits, kind, views:Object.freeze(views.slice()) });
    physical.set(id, record);
    return record;
  }

  function addView(name, physicalId, viewBits, lsb, writePolicy, kind = 'gp') {
    const storage = physical.get(physicalId);
    if (!storage) throw new TypeError(`x86-register-physical-state-missing:${physicalId}`);
    const descriptor = Object.freeze({
      id:name,
      physicalId,
      physicalBits:storage.bits,
      viewBits,
      lsb,
      writePolicy,
      kind,
    });
    descriptors.set(name, descriptor);
    return descriptor;
  }

  const legacyFamilies = [
    ['rax','eax','ax','al','ah'],
    ['rbx','ebx','bx','bl','bh'],
    ['rcx','ecx','cx','cl','ch'],
    ['rdx','edx','dx','dl','dh'],
  ];
  for (const [full,dword,word,low,high] of legacyFamilies) {
    addPhysical(full, 64, 'gp', [full,dword,word,low,high]);
    addView(full, full, 64, 0, 'replace');
    addView(dword, full, 32, 0, 'zero-extend-32');
    addView(word, full, 16, 0, 'preserve-unaffected');
    addView(low, full, 8, 0, 'preserve-unaffected');
    addView(high, full, 8, 8, 'preserve-unaffected');
  }

  const lowByteFamilies = [
    ['rsi','esi','si','sil'],
    ['rdi','edi','di','dil'],
    ['rbp','ebp','bp','bpl'],
    ['rsp','esp','sp','spl'],
  ];
  for (const [full,dword,word,low] of lowByteFamilies) {
    const kind = full === 'rsp' ? 'stack-pointer' : 'gp';
    addPhysical(full, 64, kind, [full,dword,word,low]);
    addView(full, full, 64, 0, 'replace', kind);
    addView(dword, full, 32, 0, 'zero-extend-32', kind);
    addView(word, full, 16, 0, 'preserve-unaffected', kind);
    addView(low, full, 8, 0, 'preserve-unaffected', kind);
  }

  for (let index = 8; index <= 15; index++) {
    const full = `r${index}`;
    const views = [full, `${full}d`, `${full}w`, `${full}b`];
    addPhysical(full, 64, 'gp', views);
    addView(full, full, 64, 0, 'replace');
    addView(`${full}d`, full, 32, 0, 'zero-extend-32');
    addView(`${full}w`, full, 16, 0, 'preserve-unaffected');
    addView(`${full}b`, full, 8, 0, 'preserve-unaffected');
  }

  addPhysical('rip', 64, 'program-counter', ['rip','eip','ip']);
  addView('rip', 'rip', 64, 0, 'replace', 'program-counter');
  addView('eip', 'rip', 32, 0, 'zero-extend-32', 'program-counter');
  addView('ip', 'rip', 16, 0, 'preserve-unaffected', 'program-counter');

  addPhysical('rflags', 64, 'flags', ['rflags','eflags','flags']);
  addView('rflags', 'rflags', 64, 0, 'replace', 'flags');
  addView('eflags', 'rflags', 32, 0, 'preserve-unaffected', 'flags');
  addView('flags', 'rflags', 16, 0, 'preserve-unaffected', 'flags');

  addPhysical('mxcsr', 32, 'fp-environment', ['mxcsr']);
  addView('mxcsr', 'mxcsr', 32, 0, 'replace', 'fp-environment');

  for (let index = 0; index < 16; index++) {
    const physicalId = `ymm${index}`;
    const views = [`xmm${index}`, physicalId];
    addPhysical(physicalId, 256, 'vector', views);
    addView(`xmm${index}`, physicalId, 128, 0, 'encoding-dependent-upper-lanes', 'vector');
    addView(physicalId, physicalId, 256, 0, 'replace', 'vector');
  }

  function normalizeName(value) {
    return String(value ?? '').trim().toLowerCase().replace(/^%/, '');
  }

  function registerDescriptor(value) {
    const name = normalizeName(typeof value === 'object'
      ? (value.registerId ?? value.id ?? value.name ?? value.text)
      : value);
    return descriptors.get(name) || null;
  }

  function registerFile() {
    return Object.freeze([...physical.values()].map((entry) => Object.freeze({ ...entry })));
  }

  const api = Object.freeze({
    contractVersion:'x86-physical-state/v1',
    normalizeName,
    registerDescriptor,
    registerFile,
    descriptors:Object.freeze([...descriptors.values()]),
    physicalRegisters:Object.freeze([...physical.values()]),
    modeledFlags:Object.freeze(['CF','PF','AF','ZF','SF','OF','DF']),
    unsupportedVectorFamilies:Object.freeze(['zmm','xmm16-31','ymm16-31']),
  });
  root.HexX86Registers = api;
})(globalThis);
