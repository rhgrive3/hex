/*
 * Minimal Mach-O reader — header, load commands, segments/sections.
 * Deliberately NOT a full Mach-O implementation: it extracts exactly what the
 * viewer needs to name regions and find code. Loaded via importScripts() from
 * the worker, so it defines a global instead of using ESM exports.
 *
 * All file offsets / VM addresses are BigInt.
 */
(function (root) {
  'use strict';

  const MH_MAGIC_64    = 0xfeedfacf;
  const MH_CIGAM_64    = 0xcffaedfe;
  const MH_MAGIC_32    = 0xfeedface;
  const MH_CIGAM_32    = 0xcefaedfe;
  const FAT_MAGIC      = 0xcafebabe;
  const FAT_MAGIC_64   = 0xcafebabf;

  const CPU_ARCH_ABI64    = 0x01000000;
  const CPU_ARCH_ABI64_32 = 0x02000000;
  const CPU_TYPE_ARM      = 12;
  const CPU_TYPE_X86      = 7;
  const CPU_TYPE_ARM64    = CPU_TYPE_ARM | CPU_ARCH_ABI64;      // 0x0100000C
  const CPU_TYPE_ARM64_32 = CPU_TYPE_ARM | CPU_ARCH_ABI64_32;   // 0x0200000C
  const CPU_TYPE_X86_64   = CPU_TYPE_X86 | CPU_ARCH_ABI64;      // 0x01000007
  const CPU_TYPE_PPC      = 18;

  const LC_REQ_DYLD = 0x80000000;
  const LC = {
    SEGMENT: 0x1, SYMTAB: 0x2, UNIXTHREAD: 0x5, LOAD_DYLIB: 0xc, ID_DYLIB: 0xd,
    LOAD_DYLINKER: 0xe, SEGMENT_64: 0x19, UUID: 0x1b, CODE_SIGNATURE: 0x1d,
    ENCRYPTION_INFO: 0x21, DYLD_INFO: 0x22, VERSION_MIN_MACOSX: 0x24,
    VERSION_MIN_IPHONEOS: 0x25, FUNCTION_STARTS: 0x26, ENCRYPTION_INFO_64: 0x2c,
    MAIN: 0x28 | LC_REQ_DYLD, BUILD_VERSION: 0x32, DYLD_CHAINED_FIXUPS: 0x34 | LC_REQ_DYLD,
    DYLD_EXPORTS_TRIE: 0x33 | LC_REQ_DYLD, RPATH: 0x1c | LC_REQ_DYLD,
  };
  const LC_NAMES = {};
  for (const k in LC) LC_NAMES[LC[k]] = 'LC_' + k;

  const FILETYPES = {
    1: 'MH_OBJECT', 2: 'MH_EXECUTE', 3: 'MH_FVMLIB', 4: 'MH_CORE', 5: 'MH_PRELOAD',
    6: 'MH_DYLIB', 7: 'MH_DYLINKER', 8: 'MH_BUNDLE', 9: 'MH_DYLIB_STUB',
    10: 'MH_DSYM', 11: 'MH_KEXT_BUNDLE', 12: 'MH_FILESET',
  };

  const PLATFORMS = {
    1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS', 5: 'bridgeOS',
    6: 'Mac Catalyst', 7: 'iOS Simulator', 8: 'tvOS Simulator',
    9: 'watchOS Simulator', 10: 'DriverKit', 11: 'visionOS', 12: 'visionOS Simulator',
  };

  const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
  const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;
  // section type lives in the low byte of sect.flags (S_REGULAR is 0x0)
  const S_ZEROFILL = 0x1, S_GB_ZEROFILL = 0xc, S_THREAD_LOCAL_ZEROFILL = 0x12;

  function cpuName(type, sub) {
    const s = sub & 0x00ffffff;
    switch (type) {
      case CPU_TYPE_ARM64:    return { cpu: 'ARM64', sub: s === 2 ? 'arm64e' : s === 1 ? 'arm64v8' : 'all', arm64: true };
      case CPU_TYPE_ARM64_32: return { cpu: 'ARM64_32', sub: s === 1 ? 'arm64_32 v8' : 'all', arm64: true, ilp32: true };
      case CPU_TYPE_ARM:      return { cpu: 'ARM (32-bit)', sub: 'v' + s, arm64: false };
      case CPU_TYPE_X86_64:   return { cpu: 'x86_64', sub: s === 8 ? 'h' : 'all', arm64: false };
      case CPU_TYPE_X86:      return { cpu: 'i386', sub: 'all', arm64: false };
      case CPU_TYPE_PPC:      return { cpu: 'PowerPC', sub: 'all', arm64: false };
      default:                return { cpu: '0x' + (type >>> 0).toString(16), sub: String(s), arm64: false };
    }
  }

  function cstr(u8, off, max) {
    let end = off;
    const lim = Math.min(off + max, u8.length);
    while (end < lim && u8[end] !== 0) end++;
    let s = '';
    for (let i = off; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function ver32(v) {
    return ((v >>> 16) & 0xffff) + '.' + ((v >>> 8) & 0xff) + '.' + (v & 0xff);
  }

  /** Detect container type from the first bytes. */
  function detect(buf) {
    if (buf.byteLength < 4) return { kind: 'unknown' };
    const dv = new DataView(buf);
    const be = dv.getUint32(0, false);
    if (be === FAT_MAGIC || be === FAT_MAGIC_64) return { kind: 'fat', is64: be === FAT_MAGIC_64 };
    const le = dv.getUint32(0, true);
    if (le === MH_MAGIC_64) return { kind: 'macho', is64: true, bigEndian: false };
    if (le === MH_MAGIC_32) return { kind: 'macho', is64: false, bigEndian: false };
    if (le === MH_CIGAM_64) return { kind: 'macho', is64: true, bigEndian: true };
    if (le === MH_CIGAM_32) return { kind: 'macho', is64: false, bigEndian: true };
    return { kind: 'unknown' };
  }

  /**
   * Parse a fat header. `buf` must cover at least 8 + 32*nfat bytes.
   * Returns [{offset, size, cputype, cpusubtype, name}] or null when the
   * CAFEBABE turns out to be something else (e.g. a Java class file).
   */
  function parseFat(buf, fileSize) {
    const dv = new DataView(buf);
    const magic = dv.getUint32(0, false);
    const is64 = magic === FAT_MAGIC_64;
    const n = dv.getUint32(4, false);
    if (n === 0 || n > 32) return null;               // sanity: not a real fat binary
    const entry = is64 ? 32 : 20;
    if (8 + n * entry > buf.byteLength) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = 8 + i * entry;
      const cputype = dv.getInt32(o, false);
      const cpusubtype = dv.getInt32(o + 4, false);
      const offset = is64 ? dv.getBigUint64(o + 8, false) : BigInt(dv.getUint32(o + 8, false));
      const size = is64 ? dv.getBigUint64(o + 16, false) : BigInt(dv.getUint32(o + 12, false));
      if (offset + size > fileSize) return null;      // not a fat binary after all
      const cn = cpuName(cputype, cpusubtype);
      out.push({ offset, size, cputype, cpusubtype, name: cn.cpu + (cn.sub && cn.sub !== 'all' ? ' (' + cn.sub + ')' : '') });
    }
    return out;
  }

  /**
   * Parse one Mach-O slice.
   * @param {ArrayBuffer} buf   header + load commands (starting at the slice)
   * @param {BigInt} sliceOff   offset of the slice inside the file
   * @param {BigInt} sliceSize  size of the slice
   */
  function parseSlice(buf, sliceOff, sliceSize) {
    const det = detect(buf);
    if (det.kind !== 'macho') throw new Error('Not a Mach-O image.');
    if (det.bigEndian) throw new Error('Big-endian Mach-O images are not supported.');
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const is64 = det.is64;

    const cputype = dv.getInt32(4, true);
    const cpusubtype = dv.getInt32(8, true);
    const filetype = dv.getUint32(12, true);
    const ncmds = dv.getUint32(16, true);
    const sizeofcmds = dv.getUint32(20, true);
    const flags = dv.getUint32(24, true);
    const hdrSize = is64 ? 32 : 28;

    if (ncmds > 10000 || sizeofcmds > 64 * 1024 * 1024) throw new Error('Mach-O header looks corrupt (bad load command count).');

    const cn = cpuName(cputype, cpusubtype);
    const info = {
      magic: is64 ? 'MH_MAGIC_64' : 'MH_MAGIC',
      is64, cputype, cpusubtype,
      cpu: cn.cpu, cpuSub: cn.sub, isArm64: !!cn.arm64,
      filetype, filetypeName: FILETYPES[filetype] || ('0x' + filetype.toString(16)),
      ncmds, sizeofcmds, flags,
      uuid: null, entry: null, entryFileOff: null, platform: null, minos: null, sdk: null,
      dylibCount: 0, encrypted: false, encryption: null, hasCodeSignature: false,
      commands: [], segments: [],
    };

    let off = hdrSize;
    const end = Math.min(buf.byteLength, hdrSize + sizeofcmds);
    let textVM = null, textFileOff = null;

    for (let i = 0; i < ncmds; i++) {
      if (off + 8 > end) break;
      const cmd = dv.getUint32(off, true);
      const cmdsize = dv.getUint32(off + 4, true);
      if (cmdsize < 8 || off + cmdsize > end) break;
      info.commands.push({ cmd, name: LC_NAMES[cmd] || ('0x' + (cmd >>> 0).toString(16)), size: cmdsize });

      switch (cmd) {
        case LC.SEGMENT_64:
        case LC.SEGMENT: {
          const wide = cmd === LC.SEGMENT_64;
          const segname = cstr(u8, off + 8, 16);
          let p = off + 24;
          const rd = () => {
            if (wide) { const v = dv.getBigUint64(p, true); p += 8; return v; }
            const v = BigInt(dv.getUint32(p, true)); p += 4; return v;
          };
          const vmaddr = rd(), vmsize = rd(), fileoff = rd(), filesize = rd();
          const maxprot = dv.getInt32(p, true); p += 4;
          const initprot = dv.getInt32(p, true); p += 4;
          const nsects = dv.getUint32(p, true); p += 4;
          const segflags = dv.getUint32(p, true); p += 4;

          const seg = {
            name: segname, vmaddr, vmsize, fileoff, filesize,
            maxprot, initprot, nsects, flags: segflags, sections: [],
          };
          const secSize = wide ? 80 : 68;
          for (let s = 0; s < nsects; s++) {
            const so = p + s * secSize;
            if (so + secSize > end) break;
            const sectname = cstr(u8, so, 16);
            const ssegname = cstr(u8, so + 16, 16);
            let q = so + 32;
            let addr, size;
            if (wide) { addr = dv.getBigUint64(q, true); q += 8; size = dv.getBigUint64(q, true); q += 8; }
            else { addr = BigInt(dv.getUint32(q, true)); q += 4; size = BigInt(dv.getUint32(q, true)); q += 4; }
            const offset = dv.getUint32(q, true); q += 4;
            const align = dv.getUint32(q, true); q += 4;
            q += 8; // reloff, nreloc
            const sflags = dv.getUint32(q, true);
            const type = sflags & 0xff;
            seg.sections.push({
              name: sectname, segment: ssegname || segname, addr, size,
              offset: BigInt(offset), align, flags: sflags, type,
              zerofill: type === S_ZEROFILL || type === S_GB_ZEROFILL || type === S_THREAD_LOCAL_ZEROFILL,
              exec: !!(sflags & (S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS)),
            });
          }
          if (segname === '__TEXT') { textVM = vmaddr; textFileOff = fileoff; }
          info.segments.push(seg);
          break;
        }
        case LC.UUID: {
          let s = '';
          for (let b = 0; b < 16; b++) {
            s += u8[off + 8 + b].toString(16).padStart(2, '0');
            if (b === 3 || b === 5 || b === 7 || b === 9) s += '-';
          }
          info.uuid = s.toUpperCase();
          break;
        }
        case LC.MAIN:
          info.entryOff = dv.getBigUint64(off + 8, true);
          break;
        case LC.BUILD_VERSION: {
          const platform = dv.getUint32(off + 8, true);
          info.platform = PLATFORMS[platform] || ('platform ' + platform);
          info.minos = ver32(dv.getUint32(off + 12, true));
          info.sdk = ver32(dv.getUint32(off + 16, true));
          break;
        }
        case LC.VERSION_MIN_IPHONEOS:
          info.platform = info.platform || 'iOS';
          info.minos = info.minos || ver32(dv.getUint32(off + 8, true));
          info.sdk = info.sdk || ver32(dv.getUint32(off + 12, true));
          break;
        case LC.VERSION_MIN_MACOSX:
          info.platform = info.platform || 'macOS';
          info.minos = info.minos || ver32(dv.getUint32(off + 8, true));
          break;
        case LC.LOAD_DYLIB:
          info.dylibCount++;
          break;
        case LC.CODE_SIGNATURE:
          info.hasCodeSignature = true;
          break;
        case LC.ENCRYPTION_INFO_64:
        case LC.ENCRYPTION_INFO: {
          const cryptoff = dv.getUint32(off + 8, true);
          const cryptsize = dv.getUint32(off + 12, true);
          const cryptid = dv.getUint32(off + 16, true);
          info.encryption = { cryptoff: BigInt(cryptoff), cryptsize: BigInt(cryptsize), cryptid };
          info.encrypted = cryptid !== 0;
          break;
        }
        default: break;
      }
      off += cmdsize;
    }

    if (info.entryOff != null && textVM != null && textFileOff != null) {
      // LC_MAIN's entryoff is a file offset relative to the start of the image.
      info.entryFileOff = info.entryOff;
      info.entry = textVM + (info.entryOff - textFileOff);
    }
    info.sliceOffset = sliceOff;
    info.sliceSize = sliceSize;
    return info;
  }

  /** Flatten segments/sections into viewer regions (file-backed only). */
  function regionsFrom(info, sliceOff, sliceSize, fileSize) {
    const regions = [];
    let id = 0;
    for (const seg of info.segments) {
      for (const sec of seg.sections) {
        const fileOffset = sliceOff + sec.offset;
        const avail = sec.zerofill ? 0n
          : (fileOffset >= fileSize ? 0n : bigMin(sec.size, fileSize - fileOffset));
        regions.push({
          id: 'sec' + (id++),
          kind: 'section',
          name: sec.segment + ',' + sec.name,
          segment: sec.segment,
          section: sec.name,
          fileOffset,
          vmAddr: sec.addr,
          size: avail,
          declaredSize: sec.size,
          exec: sec.exec,
          zerofill: sec.zerofill,
          truncated: !sec.zerofill && avail < sec.size,
        });
      }
    }
    return regions;
  }

  function bigMin(a, b) { return a < b ? a : b; }

  root.MachO = {
    detect, parseFat, parseSlice, regionsFrom, cpuName,
    CPU_TYPE_ARM64, CPU_TYPE_ARM64_32,
  };
})(typeof self !== 'undefined' ? self : globalThis);
