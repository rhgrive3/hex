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

  /*
   * LC_REQ_DYLD 付きのコマンド番号は 0x80000000 を立てる。
   * `|` は符号つき 32 ビットを返す（0x28|0x80000000 → 負の数）ので、
   * ファイルから getUint32 で読んだ値と一致しなくなる。必ず >>> 0 で戻すこと。
   */
  const LC_REQ_DYLD = 0x80000000;
  const req = (n) => (n | LC_REQ_DYLD) >>> 0;
  const LC = {
    SEGMENT: 0x1, SYMTAB: 0x2, UNIXTHREAD: 0x5, DYSYMTAB: 0xb, LOAD_DYLIB: 0xc, ID_DYLIB: 0xd,
    LOAD_DYLINKER: 0xe, SEGMENT_64: 0x19, UUID: 0x1b, CODE_SIGNATURE: 0x1d,
    SUB_FRAMEWORK: 0x12, TWOLEVEL_HINTS: 0x16, LOAD_WEAK_DYLIB: req(0x18),
    ENCRYPTION_INFO: 0x21, DYLD_INFO: 0x22, DYLD_INFO_ONLY: req(0x22),
    VERSION_MIN_MACOSX: 0x24,
    VERSION_MIN_IPHONEOS: 0x25, FUNCTION_STARTS: 0x26, DATA_IN_CODE: 0x29,
    SOURCE_VERSION: 0x2a, ENCRYPTION_INFO_64: 0x2c,
    REEXPORT_DYLIB: req(0x1f),
    MAIN: req(0x28), BUILD_VERSION: 0x32, DYLD_CHAINED_FIXUPS: req(0x34),
    DYLD_EXPORTS_TRIE: req(0x33), RPATH: req(0x1c),
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
  const S_CSTRING_LITERALS = 0x2;
  const S_NON_LAZY_SYMBOL_POINTERS = 0x6;
  const S_LAZY_SYMBOL_POINTERS = 0x7;
  const S_SYMBOL_STUBS = 0x8;

  // nlist n_type bits
  const N_STAB = 0xe0, N_TYPE = 0x0e, N_SECT = 0x0e, N_UNDF = 0x00;
  const N_EXT = 0x01;   // 外へ公開されている名前（エクスポート）の印
  const INDIRECT_SYMBOL_LOCAL = 0x80000000, INDIRECT_SYMBOL_ABS = 0x40000000;

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
      commands: [], segments: [], dylibs: [],
      symtab: null, dysymtab: null, functionStarts: null,
      textVM: null, textFileOff: null,
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
            const sflags = dv.getUint32(q, true); q += 4;
            const reserved1 = dv.getUint32(q, true); q += 4;
            const reserved2 = dv.getUint32(q, true);
            const type = sflags & 0xff;
            seg.sections.push({
              name: sectname, segment: ssegname || segname, addr, size,
              offset: BigInt(offset), align, flags: sflags, type, reserved1, reserved2,
              zerofill: type === S_ZEROFILL || type === S_GB_ZEROFILL || type === S_THREAD_LOCAL_ZEROFILL,
              exec: !!(sflags & (S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS)),
              cstrings: type === S_CSTRING_LITERALS,
              stubs: type === S_SYMBOL_STUBS,
              pointers: type === S_LAZY_SYMBOL_POINTERS || type === S_NON_LAZY_SYMBOL_POINTERS,
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
        case LC.LOAD_WEAK_DYLIB:
        case LC.REEXPORT_DYLIB: {
          info.dylibCount++;
          const nameOff = dv.getUint32(off + 8, true);
          if (nameOff >= 8 && nameOff < cmdsize) {
            const s = cstr(u8, off + nameOff, cmdsize - nameOff);
            if (s) info.dylibs.push(s);
          }
          break;
        }
        case LC.SYMTAB:
          info.symtab = {
            symoff: dv.getUint32(off + 8, true),
            nsyms: dv.getUint32(off + 12, true),
            stroff: dv.getUint32(off + 16, true),
            strsize: dv.getUint32(off + 20, true),
          };
          break;
        case LC.DYSYMTAB:
          if (cmdsize >= 80) {
            info.dysymtab = {
              indirectsymoff: dv.getUint32(off + 56, true),
              nindirectsyms: dv.getUint32(off + 60, true),
            };
          }
          break;
        case LC.FUNCTION_STARTS:
          info.functionStarts = {
            dataoff: dv.getUint32(off + 8, true),
            datasize: dv.getUint32(off + 12, true),
          };
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

    info.textVM = textVM;
    info.textFileOff = textFileOff;
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
          cstrings: !!sec.cstrings,
          truncated: !sec.zerofill && avail < sec.size,
        });
      }
    }
    return regions;
  }

  function bigMin(a, b) { return a < b ? a : b; }

  /* ── シンボルテーブル ─────────────────────────────────── */

  /**
   * nlist の配列を読む。
   * @param {Uint8Array} symBuf  シンボルテーブル本体
   * @param {Uint8Array} strBuf  文字列テーブル
   * @param {boolean} is64
   * @returns {{names: string[], values: BigUint64Array, types: Uint8Array, sects: Uint8Array}}
   *          添字はシンボル番号。間接シンボルの解決にそのまま使える。
   */
  function parseSymbols(symBuf, strBuf, is64) {
    const entry = is64 ? 16 : 12;
    const n = Math.floor(symBuf.length / entry);
    const dv = new DataView(symBuf.buffer, symBuf.byteOffset, symBuf.byteLength);
    const names = new Array(n);
    const values = new BigUint64Array(n);
    const types = new Uint8Array(n);
    const sects = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * entry;
      const strx = dv.getUint32(o, true);
      types[i] = symBuf[o + 4];
      sects[i] = symBuf[o + 5];
      values[i] = is64 ? dv.getBigUint64(o + 8, true) : BigInt(dv.getUint32(o + 8, true));
      names[i] = strx > 0 && strx < strBuf.length ? cstr(strBuf, strx, 1024) : '';
    }
    return { names, values, types, sects };
  }

  /** セクションに定義されている（＝アドレスを持つ）シンボルだけを取り出す。 */
  function definedSymbols(sym) {
    const out = [];
    for (let i = 0; i < sym.names.length; i++) {
      const t = sym.types[i];
      if (t & N_STAB) continue;                   // デバッグ情報
      if ((t & N_TYPE) !== N_SECT) continue;      // セクション内でないものは飛ばす
      const v = sym.values[i];
      if (v === 0n) continue;
      const name = sym.names[i];
      if (!name) continue;
      // N_EXT が立っていれば、外のライブラリからも呼べる名前（エクスポート）
      out.push({ addr: v, name, ext: !!(t & N_EXT) });
    }
    out.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0));
    return out;
  }

  /* ── LC_FUNCTION_STARTS ───────────────────────────────── */

  /** ULEB128 の差分列を、絶対アドレスの配列にほどく。 */
  function parseFunctionStarts(buf, base) {
    const out = [];
    let addr = base;
    let i = 0;
    while (i < buf.length) {
      let delta = 0n, shift = 0n, byte;
      do {
        if (i >= buf.length) return out;
        byte = buf[i++];
        delta |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
        if (shift > 70n) return out;              // 壊れている
      } while (byte & 0x80);
      if (delta === 0n) break;                    // 終端
      addr += delta;
      out.push(addr);
    }
    return out;
  }

  /* ── __unwind_info（関数の切れ目のもう 1 つの出どころ） ── */

  /**
   * compact unwind の索引から、関数の先頭を全部取り出す。
   *
   * LC_FUNCTION_STARTS を削ったバイナリでも、例外処理のために
   * `__TEXT,__unwind_info` はほぼ必ず残っている。ここには関数ごとに 1 行あり、
   * その行の先頭アドレスがそのまま関数の先頭になる。
   * 命令の並びから推測するのと違って**当てずっぽうが 1 件も混ざらない**ので、
   * 推測に頼る前に必ずこちらを見る。
   *
   * @param {Uint8Array} buf  __unwind_info の中身
   * @param {BigInt} imageBase  マッハヘッダのアドレス（関数の位置はここからの差）
   */
  function parseUnwindStarts(buf, imageBase) {
    const out = [];
    if (!buf || buf.length < 28) return out;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== 1) return out;               // 知らない版は読まない
    const indexOff = dv.getUint32(20, true);
    const indexCount = dv.getUint32(24, true);
    if (!indexCount || indexOff + indexCount * 12 > buf.length) return out;

    for (let i = 0; i < indexCount; i++) {
      const e = indexOff + i * 12;
      const funcOffset = dv.getUint32(e, true);
      const pageOff = dv.getUint32(e + 4, true);
      if (!pageOff || pageOff + 8 > buf.length) continue;      // 最後の番人の行
      const kind = dv.getUint32(pageOff, true);
      if (kind === 2) {                                        // そのまま並んでいる形
        const entryOff = dv.getUint16(pageOff + 4, true);
        const count = dv.getUint16(pageOff + 6, true);
        for (let k = 0; k < count; k++) {
          const p = pageOff + entryOff + k * 8;
          if (p + 8 > buf.length) break;
          out.push(imageBase + BigInt(dv.getUint32(p, true)));
        }
      } else if (kind === 3) {                                 // 圧縮された形
        const entryOff = dv.getUint16(pageOff + 4, true);
        const count = dv.getUint16(pageOff + 6, true);
        for (let k = 0; k < count; k++) {
          const p = pageOff + entryOff + k * 4;
          if (p + 4 > buf.length) break;
          const v = dv.getUint32(p, true);
          out.push(imageBase + BigInt(funcOffset + (v & 0x00ffffff)));
        }
      }
    }
    out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return out;
  }

  /* ── 間接シンボル（__stubs / __got の名前） ───────────── */

  /**
   * スタブや GOT の各エントリに、参照している関数名を割り当てる。
   * これがあると「_printf を呼んでいる」と読めるようになる。
   */
  function stubSymbols(info, indirectBuf, sym) {
    const out = [];
    if (!indirectBuf || !indirectBuf.length || !sym) return out;
    const dv = new DataView(indirectBuf.buffer, indirectBuf.byteOffset, indirectBuf.byteLength);
    const total = Math.floor(indirectBuf.length / 4);
    for (const seg of info.segments) {
      for (const sec of seg.sections) {
        if (!sec.stubs && !sec.pointers) continue;
        const entSize = sec.stubs ? (sec.reserved2 || 12) : 8;
        if (entSize <= 0) continue;
        const count = Number(sec.size / BigInt(entSize));
        for (let i = 0; i < count; i++) {
          const idx = sec.reserved1 + i;
          if (idx >= total) break;
          const symIdx = dv.getUint32(idx * 4, true);
          if (symIdx & (INDIRECT_SYMBOL_LOCAL | INDIRECT_SYMBOL_ABS)) continue;
          const name = sym.names[symIdx];
          if (!name) continue;
          out.push({ addr: sec.addr + BigInt(i * entSize), name, stub: !!sec.stubs });
        }
      }
    }
    return out;
  }

  root.MachO = {
    detect, parseFat, parseSlice, regionsFrom, cpuName,
    parseSymbols, definedSymbols, parseFunctionStarts, parseUnwindStarts, stubSymbols,
    CPU_TYPE_ARM64, CPU_TYPE_ARM64_32,
  };
})(typeof self !== 'undefined' ? self : globalThis);
