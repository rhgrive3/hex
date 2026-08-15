from pathlib import Path

p=Path('js/macho.js'); s=p.read_text()
# Constants + canonical CPU identity
s=s.replace("SEGMENT: 0x1, SYMTAB: 0x2, UNIXTHREAD: 0x5, DYSYMTAB: 0xb", "SEGMENT: 0x1, SYMTAB: 0x2, THREAD: 0x4, UNIXTHREAD: 0x5, DYSYMTAB: 0xb",1)

start=s.index('  function parseSlice(buf, sliceOff, sliceSize) {')
end=s.index('\n  /** Flatten segments/sections into viewer regions', start)
new_parse=r'''  function commandMinSize(cmd) {
    switch (cmd) {
      case LC.SEGMENT: return 56;
      case LC.SEGMENT_64: return 72;
      case LC.SYMTAB: return 24;
      case LC.DYSYMTAB: return 80;
      case LC.UUID: return 24;
      case LC.MAIN: return 24;
      case LC.BUILD_VERSION: return 24;
      case LC.VERSION_MIN_IPHONEOS:
      case LC.VERSION_MIN_MACOSX: return 16;
      case LC.FUNCTION_STARTS:
      case LC.CODE_SIGNATURE:
      case LC.DYLD_CHAINED_FIXUPS:
      case LC.DYLD_EXPORTS_TRIE:
      case LC.DATA_IN_CODE: return 16;
      case LC.ENCRYPTION_INFO: return 20;
      case LC.ENCRYPTION_INFO_64: return 24;
      case LC.LOAD_DYLIB:
      case LC.LOAD_WEAK_DYLIB:
      case LC.REEXPORT_DYLIB:
      case LC.ID_DYLIB: return 24;
      case LC.RPATH: return 12;
      case LC.THREAD:
      case LC.UNIXTHREAD: return 16;
      default: return 8;
    }
  }

  function architectureOf(cn) {
    if (cn.ilp32) return 'arm64_32';
    if (cn.arm64 && cn.sub === 'arm64e') return 'arm64e';
    if (cn.arm64) return 'arm64';
    if (cn.cpu === 'ARM (32-bit)') return 'arm';
    return String(cn.cpu || 'unknown').toLowerCase();
  }

  function instructionAlignment(arch) {
    return arch === 'arm64' || arch === 'arm64e' || arch === 'arm64_32' ? 4n : arch === 'arm' ? 2n : 1n;
  }

  function inRange(value, start, size) {
    return size > 0n && value >= start && value - start < size;
  }

  function parseThreadEntrypoint(dv, off, commandEnd, cputype) {
    let p = off + 8;
    while (p + 8 <= commandEnd) {
      const flavor = dv.getUint32(p, true);
      const count = dv.getUint32(p + 4, true);
      const state = p + 8;
      const bytes = count * 4;
      if (!Number.isSafeInteger(bytes) || state + bytes > commandEnd) return null;
      if (cputype === CPU_TYPE_ARM64 || cputype === CPU_TYPE_ARM64_32) {
        if (flavor === 6 && count >= 68 && state + 264 <= commandEnd) return dv.getBigUint64(state + 256, true);
      } else if (cputype === CPU_TYPE_ARM) {
        if (flavor === 1 && count >= 17 && state + 64 <= commandEnd) return BigInt(dv.getUint32(state + 60, true));
      } else if (cputype === CPU_TYPE_X86_64) {
        if (flavor === 4 && count >= 42 && state + 136 <= commandEnd) return dv.getBigUint64(state + 128, true);
      }
      p = state + bytes;
    }
    return null;
  }

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
    if (hdrSize + sizeofcmds > buf.byteLength) throw new Error('Mach-O load command area is truncated.');

    const cn = cpuName(cputype, cpusubtype);
    const architecture = architectureOf(cn);
    const info = {
      magic: is64 ? 'MH_MAGIC_64' : 'MH_MAGIC', is64, cputype, cpusubtype,
      cpu: cn.cpu, cpuSub: cn.sub, isArm64: !!cn.arm64, ilp32: !!cn.ilp32,
      architecture, pointerBits: cn.ilp32 ? 32 : (is64 ? 64 : 32),
      instructionAlignment: Number(instructionAlignment(architecture)),
      filetype, filetypeName: FILETYPES[filetype] || ('0x' + filetype.toString(16)),
      ncmds, sizeofcmds, flags, uuid: null, entry: null, entryFileOff: null, entrySource: null,
      platform: null, minos: null, sdk: null, dylibCount: 0, encrypted: false, encryption: null,
      hasCodeSignature: false, commands: [], segments: [], dylibs: [], symtab: null, dysymtab: null,
      functionStarts: null, textVM: null, textFileOff: null, diagnostics: [],
    };
    let off = hdrSize;
    const end = hdrSize + sizeofcmds;
    let textVM = null, textFileOff = null;
    const threadEntries = [];

    for (let i = 0; i < ncmds; i++) {
      if (off + 8 > end) { info.diagnostics.push('truncated load-command header'); break; }
      const cmd = dv.getUint32(off, true);
      const cmdsize = dv.getUint32(off + 4, true);
      if (cmdsize < 8 || off + cmdsize > end) { info.diagnostics.push('invalid load-command size'); break; }
      const commandEnd = off + cmdsize;
      info.commands.push({ cmd, name: LC_NAMES[cmd] || ('0x' + (cmd >>> 0).toString(16)), size: cmdsize });
      const minimum = commandMinSize(cmd);
      if (cmdsize < minimum) {
        info.diagnostics.push((LC_NAMES[cmd] || 'load command') + ' shorter than ABI minimum');
        off = commandEnd;
        continue;
      }

      switch (cmd) {
        case LC.SEGMENT_64:
        case LC.SEGMENT: {
          const wide = cmd === LC.SEGMENT_64;
          const baseSize = wide ? 72 : 56;
          const secSize = wide ? 80 : 68;
          const segname = cstr(u8, off + 8, Math.min(16, commandEnd - (off + 8)));
          let p = off + 24;
          const rd = () => { if (wide) { const v=dv.getBigUint64(p,true); p+=8; return v; } const v=BigInt(dv.getUint32(p,true)); p+=4; return v; };
          const vmaddr=rd(), vmsize=rd(), fileoff=rd(), filesize=rd();
          const maxprot=dv.getInt32(p,true); p+=4;
          const initprot=dv.getInt32(p,true); p+=4;
          const nsects=dv.getUint32(p,true); p+=4;
          const segflags=dv.getUint32(p,true); p+=4;
          const sectionBytes = BigInt(nsects) * BigInt(secSize);
          if (sectionBytes > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(baseSize) + sectionBytes > BigInt(cmdsize)) {
            info.diagnostics.push(segname + ': section table exceeds command');
            break;
          }
          const fileEnd=fileoff+filesize, vmEnd=vmaddr+vmsize;
          const validMapping = filesize <= vmsize && fileoff <= sliceSize && fileEnd >= fileoff && fileEnd <= sliceSize && vmEnd >= vmaddr;
          if (!validMapping) info.diagnostics.push(segname + ': invalid segment file/VM range');
          const seg={name:segname,vmaddr,vmsize,fileoff,filesize,maxprot,initprot,nsects,flags:segflags,sections:[],validMapping};
          for (let si=0; si<nsects; si++) {
            const so=off+baseSize+si*secSize;
            if (so+secSize > commandEnd) break;
            const sectname=cstr(u8,so,16), ssegname=cstr(u8,so+16,16);
            let q=so+32; let addr,size;
            if (wide) { addr=dv.getBigUint64(q,true); q+=8; size=dv.getBigUint64(q,true); q+=8; }
            else { addr=BigInt(dv.getUint32(q,true)); q+=4; size=BigInt(dv.getUint32(q,true)); q+=4; }
            const offset=BigInt(dv.getUint32(q,true)); q+=4;
            const align=dv.getUint32(q,true); q+=4; q+=8;
            const sflags=dv.getUint32(q,true); q+=4;
            const reserved1=dv.getUint32(q,true); q+=4;
            const reserved2=dv.getUint32(q,true);
            const type=sflags&0xff;
            const zerofill=type===S_ZEROFILL||type===S_GB_ZEROFILL||type===S_THREAD_LOCAL_ZEROFILL;
            const secEnd=addr+size, secFileEnd=offset+size;
            const vmInside=addr>=vmaddr && secEnd>=addr && secEnd<=vmEnd;
            const fileInside=zerofill || (offset>=fileoff && secFileEnd>=offset && secFileEnd<=fileEnd && secFileEnd<=sliceSize);
            const valid=validMapping && vmInside && fileInside;
            if (!valid) info.diagnostics.push((ssegname||segname)+','+sectname+': section outside parent/slice range');
            seg.sections.push({name:sectname,segment:ssegname||segname,addr,size,offset,align,flags:sflags,type,reserved1,reserved2,
              zerofill,exec:!!(sflags&(S_ATTR_PURE_INSTRUCTIONS|S_ATTR_SOME_INSTRUCTIONS))||!!(initprot&4),cstrings:type===S_CSTRING_LITERALS,
              stubs:type===S_SYMBOL_STUBS,pointers:type===S_LAZY_SYMBOL_POINTERS||type===S_NON_LAZY_SYMBOL_POINTERS,validMapping:valid});
          }
          if (segname==='__TEXT' && validMapping) { textVM=vmaddr; textFileOff=fileoff; }
          info.segments.push(seg);
          break;
        }
        case LC.UUID: {
          let value=''; for(let bi=0;bi<16;bi++){value+=u8[off+8+bi].toString(16).padStart(2,'0'); if(bi===3||bi===5||bi===7||bi===9)value+='-';}
          info.uuid=value.toUpperCase(); break;
        }
        case LC.MAIN: info.entryOff=dv.getBigUint64(off+8,true); break;
        case LC.THREAD:
        case LC.UNIXTHREAD: {
          const pc=parseThreadEntrypoint(dv,off,commandEnd,cputype); if(pc!=null) threadEntries.push(pc); else info.diagnostics.push('malformed/unsupported thread state'); break;
        }
        case LC.BUILD_VERSION: {
          const platform=dv.getUint32(off+8,true); info.platform=PLATFORMS[platform]||('platform '+platform);
          info.minos=ver32(dv.getUint32(off+12,true)); info.sdk=ver32(dv.getUint32(off+16,true)); break;
        }
        case LC.VERSION_MIN_IPHONEOS: info.platform=info.platform||'iOS'; info.minos=info.minos||ver32(dv.getUint32(off+8,true)); info.sdk=info.sdk||ver32(dv.getUint32(off+12,true)); break;
        case LC.VERSION_MIN_MACOSX: info.platform=info.platform||'macOS'; info.minos=info.minos||ver32(dv.getUint32(off+8,true)); info.sdk=info.sdk||ver32(dv.getUint32(off+12,true)); break;
        case LC.LOAD_DYLIB:
        case LC.LOAD_WEAK_DYLIB:
        case LC.REEXPORT_DYLIB: {
          info.dylibCount++; const nameOff=dv.getUint32(off+8,true);
          if(nameOff>=24&&off+nameOff<commandEnd){const value=cstr(u8,off+nameOff,commandEnd-(off+nameOff));if(value)info.dylibs.push(value);} break;
        }
        case LC.SYMTAB: info.symtab={symoff:dv.getUint32(off+8,true),nsyms:dv.getUint32(off+12,true),stroff:dv.getUint32(off+16,true),strsize:dv.getUint32(off+20,true)}; break;
        case LC.DYSYMTAB: info.dysymtab={indirectsymoff:dv.getUint32(off+56,true),nindirectsyms:dv.getUint32(off+60,true)}; break;
        case LC.FUNCTION_STARTS: info.functionStarts={dataoff:dv.getUint32(off+8,true),datasize:dv.getUint32(off+12,true)}; break;
        case LC.CODE_SIGNATURE: info.hasCodeSignature=true; break;
        case LC.ENCRYPTION_INFO_64:
        case LC.ENCRYPTION_INFO: {
          const cryptoff=dv.getUint32(off+8,true),cryptsize=dv.getUint32(off+12,true),cryptid=dv.getUint32(off+16,true);
          info.encryption={cryptoff:BigInt(cryptoff),cryptsize:BigInt(cryptsize),cryptid}; info.encrypted=cryptid!==0; break;
        }
        default: break;
      }
      off=commandEnd;
    }

    info.textVM=textVM; info.textFileOff=textFileOff;
    const align=instructionAlignment(architecture);
    const execSegments=info.segments.filter((seg)=>seg.validMapping && !!(seg.initprot&4) && seg.vmsize>0n);
    const validPc=(pc)=>pc!=null && pc%align===0n && execSegments.some((seg)=>inRange(pc,seg.vmaddr,seg.vmsize));
    if (info.entryOff != null) {
      const seg=execSegments.find((candidate)=>inRange(info.entryOff,candidate.fileoff,candidate.filesize));
      if (seg) {
        const pc=seg.vmaddr+(info.entryOff-seg.fileoff);
        if (validPc(pc)) { info.entryFileOff=info.entryOff; info.entry=pc; info.entrySource='LC_MAIN'; }
      }
      if (info.entry==null) info.diagnostics.push('LC_MAIN entryoff is outside executable mapping/alignment');
    }
    if (info.entry==null) {
      for (const pc0 of threadEntries) {
        const pc=architecture==='arm' ? (pc0 & ~1n) : pc0;
        if (validPc(pc)) { info.entry=pc; info.entrySource='LC_THREAD'; break; }
      }
      if (threadEntries.length && info.entry==null) info.diagnostics.push('thread entrypoint is outside executable mapping/alignment');
    }
    info.sliceOffset=sliceOff; info.sliceSize=sliceSize;
    return info;
  }

  function regionsFrom(info, sliceOff, sliceSize, fileSize) {
    const regions=[]; let id=0;
    const sliceEnd=sliceOff+sliceSize;
    if (sliceEnd<sliceOff || sliceEnd>fileSize) return regions;
    for(const seg of info.segments||[]){
      if(!seg.validMapping) continue;
      for(const sec of seg.sections||[]){
        if(!sec.validMapping) continue;
        const fileOffset=sliceOff+sec.offset;
        let avail=0n;
        if(!sec.zerofill){
          const end=fileOffset+sec.size;
          if(end<fileOffset||fileOffset<sliceOff||end>sliceEnd||end>fileSize) continue;
          avail=sec.size;
        }
        regions.push({id:'sec'+(id++),kind:'section',name:sec.segment+','+sec.name,segment:sec.segment,section:sec.name,
          fileOffset,vmAddr:sec.addr,size:avail,declaredSize:sec.size,exec:sec.exec,zerofill:sec.zerofill,cstrings:!!sec.cstrings,truncated:false});
      }
    }
    return regions;
  }
'''
s=s[:start]+new_parse+s[end:]
# Remove old regionsFrom duplicate (new_parse is inserted immediately before its doc comment; replace following old function)
marker='  /** Flatten segments/sections into viewer regions (file-backed only). */\n  function regionsFrom(info, sliceOff, sliceSize, fileSize) {'
if marker in s:
    a=s.index(marker)
    b=s.index('\n  function bigMin',a)
    s=s[:a]+s[b:]

# validated function-start decoder
start=s.index('  function parseFunctionStarts(buf, base) {')
end=s.index('\n  /* ── __unwind_info',start)
new_fs=r'''  function parseFunctionStarts(buf, base, options = {}) {
    const out=[]; let addr=base; let i=0; let malformed=false; let rejected=0;
    const regions=Array.isArray(options.regions)?options.regions:[];
    const alignment=instructionAlignment(options.architecture||'arm64');
    const valid=(value)=>value%alignment===0n && (!regions.length || regions.some((r)=>r.exec&&r.size>0n&&value>=r.vmAddr&&value-r.vmAddr<r.size));
    while(i<buf.length){
      let delta=0n,shift=0n,byte=0;
      do {
        if(i>=buf.length){malformed=true;break;}
        byte=buf[i++]; delta|=BigInt(byte&0x7f)<<shift; shift+=7n;
        if(shift>70n){malformed=true;break;}
      } while(byte&0x80);
      if(malformed||delta===0n) break;
      const next=addr+delta;
      if(next<addr){malformed=true;break;}
      addr=next;
      if(valid(addr)) out.push(addr); else rejected++;
    }
    out.rejected=rejected; out.complete=!malformed&&rejected===0; out.malformed=malformed;
    return out;
  }
'''
s=s[:start]+new_fs+s[end:]
p.write_text(s)

# Worker consumes validated starts and authoritative entry seed.
p=Path('js/worker-legacy.js'); s=p.read_text()
old="""      const list = MachO.parseFunctionStarts(buf, info.textVM);
      funcs = new BigUint64Array(list.length);
      for (let i = 0; i < list.length; i++) funcs[i] = list[i];
      functionStartsExact = list.length > 0;"""
new="""      const list = MachO.parseFunctionStarts(buf, info.textVM, { regions:slice.regions || [], architecture:info.architecture || 'arm64' });
      const seeds = list.slice();
      if (info.entry != null && !seeds.some((value) => value === info.entry)) seeds.push(info.entry);
      seeds.sort((a,b)=>(a<b?-1:a>b?1:0));
      funcs = new BigUint64Array(seeds.length);
      for (let i = 0; i < seeds.length; i++) funcs[i] = seeds[i];
      functionStartsExact = list.length > 0 && list.complete === true;"""
if old not in s: raise SystemExit('worker function starts anchor changed')
s=s.replace(old,new,1)
# entry-only if no LC_FUNCTION_STARTS
anchor="""  /* Known noreturn imports make the instruction after a call a strong boundary"""
insert="""  if ((!info.functionStarts || !info.functionStarts.datasize) && info.entry != null) {
    funcs = new BigUint64Array([info.entry]);
    functionStartsExact = false;
  }

"""+anchor
if insert not in s: s=s.replace(anchor,insert,1)
p.write_text(s)

# Backend preserves ABI identity/capability.
p=Path('js/backend.js'); s=p.read_text()
a=s.index('function legacySliceCapability(slice) {')
b=len(s)
# capability is final function currently; replace to EOF but preserve trailing newline.
new_cap="""function legacySliceCapability(slice) {
  const info = slice?.info || {};
  const architecture = info.architecture || (info.ilp32 ? 'arm64_32' : info.cpuSub === 'arm64e' ? 'arm64e' : info.isArm64 ? 'arm64' : String(info.cpu || 'unknown').toLowerCase());
  const aarch64 = architecture === 'arm64' || architecture === 'arm64e' || architecture === 'arm64_32';
  const partial = architecture === 'arm64e' || architecture === 'arm64_32';
  const limitations = architecture === 'arm64e' ? ['pointer-authentication'] : architecture === 'arm64_32' ? ['ilp32-pointer-abi'] : [];
  return Object.freeze({
    format:'macho', architecture, endianness:'little', bits:info.is64===false?32:64,
    pointerBits:info.pointerBits || (info.ilp32?32:(info.is64===false?32:64)), ilp32:!!info.ilp32,
    canDisassemble:aarch64, canAnalyzeDataflow:aarch64, canEmulate:false, viewerCanDisassemble:aarch64,
    instructionAlignment:aarch64?4:(architecture==='arm'?2:1), fixedInstructionSize:aarch64?4:null,
    analysisLevel:partial?'partial':aarch64?'full':'data-only', limitations, engineVerified:false,
  });
}
"""
s=s[:a]+new_cap
p.write_text(s)

# New platform parser: ARM64e alignment is also 4-byte.
p=Path('js/binary/macho.js'); s=p.read_text()
s=s.replace("const alignment = image.arch === 'arm64' ? 4n : image.arch === 'arm' ? 2n : 1n;", "const alignment = (image.arch === 'arm64' || image.arch === 'arm64e' || image.arch === 'arm64_32') ? 4n : image.arch === 'arm' ? 2n : 1n;")
p.write_text(s)
