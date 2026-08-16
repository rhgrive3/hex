'use strict';
importScripts('../../capstone.js');

self.onmessage = async () => {
  try {
    const M = await MCapstone({ locateFile: (p) => new URL('../../' + p, self.location.href).href, print: () => {}, printErr: () => {} });
    const probe = (arch, mode) => {
      const hp = M._malloc(4);
      try {
        const rc = M.ccall('cs_open', 'number', ['number', 'number', 'pointer'], [arch, mode, hp]);
        if (rc !== 0) return false;
        const handle = M.getValue(hp, 'i32');
        if (handle) M.ccall('cs_close', 'number', ['pointer'], [hp]);
        return true;
      } finally { M._free(hp); }
    };
    self.postMessage({ ok: true, support: {
      arm64: probe(M.ARCH_ARM64, M.MODE_ARM | M.MODE_LITTLE_ENDIAN),
      x86_64: probe(M.ARCH_X86, M.MODE_64 | M.MODE_LITTLE_ENDIAN),
    }});
  } catch (error) {
    self.postMessage({ ok: false, error: `Capstone probe initialization: ${error?.message || String(error)}`, support: { arm64: false, x86_64: false } });
  }
};
