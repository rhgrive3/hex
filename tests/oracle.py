#!/usr/bin/env python3
"""
正解表（オラクル）を作る。

このツール（js/）とは**別実装**で同じバイナリを読み、
「本当はこうなっている」を JSON に書き出す。精度はこれと突き合わせて測る。

  python3 tests/oracle.py tests/battlecats tests/oracle.battlecats.json

使うのは Mach-O 自身が持っている情報だけ:
  - LC_FUNCTION_STARTS      … 関数の先頭（コンパイラが書いた事実）
  - LC_SYMTAB / exports     … 名前が残っている関数
  - LC_DYLD_CHAINED_FIXUPS  … ポインタの本当の行き先と、輸入シンボル名
  - __objc_* / __swift5_*   … クラス・フィールド・メソッドの表
  - capstone                … 命令の解読（js 側は capstone.wasm、こちらは python）

出力は「サンプル」ではなく全量。数十 MB になるので gzip する。
"""
import json, struct, sys, gzip, os, random, re
from collections import defaultdict

import lief
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

# ── Mach-O の素読み ──────────────────────────────────────────

class Image:
    def __init__(self, path):
        self.buf = open(path, 'rb').read()
        self.bin = lief.MachO.parse(path).at(0)
        self.sections = {}
        for s in self.bin.sections:
            self.sections[(s.segment_name, s.name)] = s
        self.segs = []
        for sg in self.bin.segments:
            if sg.virtual_size:
                self.segs.append((sg.virtual_address, sg.virtual_size, sg.file_offset, sg.name))
        self.base = min(sg[0] for sg in self.segs if sg[3] == '__TEXT')

    def off(self, vm):
        for va, vs, fo, name in self.segs:
            if va <= vm < va + vs:
                return fo + (vm - va)
        return None

    def read(self, vm, n):
        o = self.off(vm)
        if o is None or o + n > len(self.buf):
            return None
        return self.buf[o:o + n]

    def u64(self, vm):
        b = self.read(vm, 8)
        return struct.unpack('<Q', b)[0] if b else None

    def u32(self, vm):
        b = self.read(vm, 4)
        return struct.unpack('<I', b)[0] if b else None

    def cstr(self, vm, limit=512):
        o = self.off(vm)
        if o is None:
            return None
        e = self.buf.find(b'\0', o, o + limit)
        if e < 0:
            return None
        try:
            return self.buf[o:e].decode('utf-8')
        except UnicodeDecodeError:
            return self.buf[o:e].decode('latin-1')


# ── chained fixups: ポインタの本当の値 ────────────────────────

def chained_fixups(img):
    """vmaddr -> ('rebase', target_vm) | ('bind', symbol_name) を全部作る。"""
    cf = img.bin.dyld_chained_fixups
    if cf is None:
        return {}, {}
    raw = bytes(cf.payload)
    (fixups_version, starts_off, imports_off, symbols_off,
     imports_count, imports_format, symbols_format) = struct.unpack('<7I', raw[:28])

    # 輸入シンボル表
    imports = []
    for i in range(imports_count):
        if imports_format == 1:      # DYLD_CHAINED_IMPORT
            v = struct.unpack('<I', raw[imports_off + i * 4: imports_off + i * 4 + 4])[0]
            name_off = v >> 9
        elif imports_format == 2:    # ADDEND
            v = struct.unpack('<Q', raw[imports_off + i * 8: imports_off + i * 8 + 8])[0]
            name_off = (v >> 9) & 0x7FFFFF
        else:                        # ADDEND64
            v = struct.unpack('<Q', raw[imports_off + i * 16: imports_off + i * 16 + 8])[0]
            name_off = v >> 32
        s = symbols_off + name_off
        e = raw.find(b'\0', s)
        imports.append(raw[s:e].decode('utf-8', 'replace'))

    rebase, bind = {}, {}
    seg_count = struct.unpack('<I', raw[starts_off: starts_off + 4])[0]
    seg_offs = struct.unpack('<%dI' % seg_count, raw[starts_off + 4: starts_off + 4 + seg_count * 4])
    segments = list(img.bin.segments)
    for si, so in enumerate(seg_offs):
        if so == 0:
            continue
        p = starts_off + so
        size, page_size, ptr_format, seg_offset, max_valid, page_count = \
            struct.unpack('<IHHQIH', raw[p:p + 22])
        starts = struct.unpack('<%dH' % page_count, raw[p + 22: p + 22 + page_count * 2])
        seg_vm = segments[si].virtual_address
        for pi, st in enumerate(starts):
            if st == 0xFFFF:
                continue
            cur = seg_vm + pi * page_size + st
            while True:
                v = img.u64(cur)
                if v is None:
                    break
                if ptr_format == 2:      # DYLD_CHAINED_PTR_64
                    is_bind = (v >> 63) & 1
                    nxt = (v >> 51) & 0xFFF
                    if is_bind:
                        ordinal = v & 0xFFFFFF
                        if ordinal < len(imports):
                            bind[cur] = imports[ordinal]
                    else:
                        target = v & 0xFFFFFFFFF            # 36 bit, image 先頭からの距離
                        high8 = (v >> 36) & 0xFF
                        rebase[cur] = img.base + target + (high8 << 56)
                elif ptr_format == 6:    # DYLD_CHAINED_PTR_64_OFFSET
                    is_bind = (v >> 63) & 1
                    nxt = (v >> 51) & 0xFFF
                    if is_bind:
                        ordinal = v & 0xFFFFFF
                        if ordinal < len(imports):
                            bind[cur] = imports[ordinal]
                    else:
                        rebase[cur] = img.base + (v & 0xFFFFFFFFF)
                else:
                    break
                if nxt == 0:
                    break
                cur += nxt * 4
    return rebase, bind


def ptr_at(img, vm, rebase, bind):
    """chained fixups をほどいた本当のポインタ値。"""
    if vm in rebase:
        return rebase[vm]
    if vm in bind:
        return None
    v = img.u64(vm)
    if v is None:
        return None
    # 生の値が既に妥当ならそのまま
    return v if img.off(v) is not None else None


# ── Objective-C の表 ─────────────────────────────────────────

def objc_classes(img, rebase, bind):
    sec = img.sections.get(('__DATA_CONST', '__objc_classlist')) or \
          img.sections.get(('__DATA', '__objc_classlist'))
    if sec is None:
        return []
    out = []
    n = sec.size // 8
    for i in range(n):
        cls_vm = ptr_at(img, sec.virtual_address + i * 8, rebase, bind)
        if cls_vm is None:
            continue
        c = read_class(img, cls_vm, rebase, bind)
        if c:
            out.append(c)
    return out


def read_class(img, cls_vm, rebase, bind, depth=0):
    # struct objc_class { isa, superclass, cache, vtable, data(class_ro_t*) }
    data = ptr_at(img, cls_vm + 32, rebase, bind)
    if data is None:
        return None
    data &= ~3
    ro = img.read(data, 72)
    if ro is None:
        return None
    flags, start, size, reserved = struct.unpack('<IIII', ro[:16])
    name_p = struct.unpack('<Q', ro[24:32])[0]
    name_p = rebase.get(data + 24, name_p)
    name = img.cstr(name_p) if img.off(name_p) is not None else None
    if not name:
        return None
    methods_p = rebase.get(data + 32, struct.unpack('<Q', ro[32:40])[0])
    ivars_p = rebase.get(data + 48, struct.unpack('<Q', ro[48:56])[0])
    sup = ptr_at(img, cls_vm + 8, rebase, bind)
    sup_name = None
    if sup is not None and img.off(sup) is not None and depth < 1:
        s = read_class(img, sup, rebase, bind, depth + 1)
        sup_name = s['name'] if s else None
    return {
        'name': name,
        'super': sup_name,
        'meta': bool(flags & 1),
        'instanceSize': size,
        'ivars': read_ivars(img, ivars_p, rebase) if ivars_p else [],
        'methods': read_methods(img, methods_p, rebase) if methods_p else [],
    }


def read_ivars(img, vm, rebase):
    hdr = img.read(vm, 8)
    if hdr is None:
        return []
    entsize, count = struct.unpack('<II', hdr)
    if entsize != 32 or count > 4096:
        return []
    out = []
    for i in range(count):
        p = vm + 8 + i * 32
        b = img.read(p, 32)
        if b is None:
            break
        off_p = rebase.get(p, struct.unpack('<Q', b[0:8])[0])
        name_p = rebase.get(p + 8, struct.unpack('<Q', b[8:16])[0])
        type_p = rebase.get(p + 16, struct.unpack('<Q', b[16:24])[0])
        align, size = struct.unpack('<II', b[24:32])
        offv = img.u32(off_p) if img.off(off_p) is not None else None
        out.append({
            'name': img.cstr(name_p) if img.off(name_p) is not None else None,
            'type': img.cstr(type_p) if img.off(type_p) is not None else None,
            'offset': offv, 'size': size,
        })
    return [i for i in out if i['name']]


def read_methods(img, vm, rebase):
    hdr = img.read(vm, 8)
    if hdr is None:
        return []
    entsize_raw, count = struct.unpack('<II', hdr)
    small = bool(entsize_raw & 0x80000000)
    direct_selectors = bool(entsize_raw & 0x40000000)
    entsize = entsize_raw & 0xFFFC
    if entsize not in (12, 24) or count > 8192:
        return []
    out = []
    for i in range(count):
        p = vm + 8 + i * entsize
        b = img.read(p, entsize)
        if b is None:
            break
        if small:
            n_off, t_off, i_off = struct.unpack('<iii', b[:12])
            # Relative method lists have two selector encodings.  With
            # METHOD_LIST_FLAG_RELATIVE_DIRECT_SELECTORS (0x40000000), the
            # name relative pointer targets the selector string directly.
            # Otherwise it targets a selref whose pointee is the string.
            sel_ref = p + n_off
            if direct_selectors:
                sel_p = sel_ref
            else:
                sel_p = rebase.get(sel_ref, img.u64(sel_ref) or 0)
            name = img.cstr(sel_p) if img.off(sel_p) is not None else None
            imp = p + 8 + i_off
        else:
            name_p = rebase.get(p, struct.unpack('<Q', b[0:8])[0])
            name = img.cstr(name_p) if img.off(name_p) is not None else None
            imp = rebase.get(p + 16, struct.unpack('<Q', b[16:24])[0])
        if name and img.off(imp) is not None:
            out.append({'name': name, 'addr': imp})
    return out


# ── 命令の解読（capstone python） ─────────────────────────────

_REGX = re.compile(r'^[wx](\d+)$')

# 何も書き換えない命令（比較・分岐・システム）
_NO_WRITE = {
    'cmp', 'cmn', 'tst', 'fcmp', 'fcmpe', 'ccmp', 'ccmn',
    'b', 'bl', 'br', 'blr', 'braa', 'brab', 'blraa', 'blrab',
    'cbz', 'cbnz', 'tbz', 'tbnz', 'ret', 'retaa', 'retab',
    'nop', 'hint', 'bti', 'dmb', 'dsb', 'isb', 'svc', 'brk', 'udf', 'prfm',
    'msr', 'sys', 'pacibsp', 'autibsp', 'paciasp', 'autiasp',
}
_WB = re.compile(r'\[(\w+)[^\]]*\]!|\[(\w+)\],')


def written_regs(mn, ops):
    """その命令が書き換えるレジスタ。

    capstone の detail を使うと 450 万命令ぶんのメモリが要るので、綴りから決める。
    迷うときは「書き換えた」側に倒す（追跡をやめるだけで、嘘は言わない）。
    """
    out = set()
    m = _WB.search(ops)                       # 書き戻しつきのアドレッシング
    if m:
        out.add(reg_x(m.group(1) or m.group(2)))
    if mn in _NO_WRITE or mn.startswith('b.'):
        return out
    if mn.startswith('st') and not mn.startswith('stx') and not mn.startswith('stlx'):
        return out                            # 保存するだけ。第 1 引数は読まれる側
    parts = [p.strip() for p in ops.split(',')]
    n = 2 if mn.startswith('ldp') or mn.startswith('ldnp') or mn.startswith('ldxp') else 1
    for p in parts[:n]:
        if _REGX.match(p):
            out.add(reg_x(p))
    return out


def reg_x(name):
    """w8 と x8 は同じ入れ物。呼び名をそろえる。"""
    m = _REGX.match(name)
    return 'x' + m.group(1) if m else name


def disasm_text(img):
    sec = img.sections[('__TEXT', '__text')]
    code = img.buf[sec.offset: sec.offset + sec.size]
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    md.detail = False
    md.skipdata = True
    return sec.virtual_address, code, md


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'tests/battlecats'
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'tests/oracle.%s.json.gz' % os.path.basename(path)
    img = Image(path)
    say = lambda *a: print(*a, file=sys.stderr)

    say('chained fixups…')
    rebase, bind = chained_fixups(img)
    say('  rebase %d bind %d' % (len(rebase), len(bind)))

    say('objc…')
    classes = objc_classes(img, rebase, bind)
    say('  classes %d ivars %d methods %d' % (
        len(classes), sum(len(c['ivars']) for c in classes), sum(len(c['methods']) for c in classes)))

    say('function starts…')
    fs = sorted(img.bin.function_starts.functions) if img.bin.function_starts else []
    fs = [img.base + f if f < img.base else f for f in fs]
    say('  %d' % len(fs))

    say('symbols…')
    syms = {}
    for s in img.bin.symbols:
        if s.value and img.off(s.value) is not None:
            syms[s.value] = s.name

    # __stubs -> 輸入名（__got 経由）。stub は 12 バイト固定 (adrp/ldr/br)。
    say('stubs…')
    stubs = {}
    ssec = img.sections.get(('__TEXT', '__stubs'))
    if ssec:
        _, _, md = disasm_text(img)
        code = img.buf[ssec.offset: ssec.offset + ssec.size]
        page = None
        cur_reg = {}
        for ins in md.disasm(code, ssec.virtual_address):
            if ins.mnemonic == 'adrp':
                r, imm = [x.strip() for x in ins.op_str.split(',')]
                cur_reg[r] = int(imm.lstrip('#'), 0)
            elif ins.mnemonic == 'ldr' and '[' in ins.op_str:
                m = re.match(r'(\w+), \[(\w+)(?:, #(-?0x[0-9a-fA-F]+|-?\d+))?\]$', ins.op_str)
                if m and m.group(2) in cur_reg:
                    got = cur_reg[m.group(2)] + (int(m.group(3).lstrip('#'), 0) if m.group(3) else 0)
                    cur_reg[m.group(1)] = None
                    cur_reg['__last_got'] = got
            elif ins.mnemonic == 'br':
                got = cur_reg.get('__last_got')
                if got is not None and got in bind:
                    stubs[ins.address - 8] = bind[got]
                cur_reg = {}
    say('  %d' % len(stubs))

    # objc_stubs: _objc_msgSend$selector
    objc_stubs = {}
    osec = img.sections.get(('__TEXT', '__objc_stubs'))
    if osec:
        _, _, md = disasm_text(img)
        code = img.buf[osec.offset: osec.offset + osec.size]
        start = None
        adrp = {}
        for ins in md.disasm(code, osec.virtual_address):
            if ins.mnemonic == 'adrp':
                r, imm = [x.strip() for x in ins.op_str.split(',')]
                adrp[r] = int(imm.lstrip('#'), 0)
                if start is None:
                    start = ins.address
            elif ins.mnemonic == 'ldr' and '[' in ins.op_str:
                m = re.match(r'(\w+), \[(\w+)(?:, #(-?0x[0-9a-fA-F]+|-?\d+))?\]$', ins.op_str)
                if m and m.group(2) in adrp and m.group(1) == 'x1':
                    selref = adrp[m.group(2)] + (int(m.group(3).lstrip('#'), 0) if m.group(3) else 0)
                    selp = rebase.get(selref, img.u64(selref) or 0)
                    sel = img.cstr(selp) if img.off(selp) is not None else None
                    if sel and start is not None:
                        objc_stubs[start] = sel
            elif ins.mnemonic in ('br', 'ret'):
                start = None
                adrp = {}
    say('  objc_stubs %d' % len(objc_stubs))

    say('disassembling __text…')
    tvm, code, md = disasm_text(img)
    calls = []              # (src_addr, dst_addr)
    branches = 0
    insn_count = 0
    kinds = defaultdict(int)
    adrp_reg = {}
    adr_targets = {}        # addr -> resolved address (adrp+add / adrp+ldr)
    rnd = random.Random(20260812)
    sample_insns = []       # [addr, mnemonic, op_str] を等間隔で
    sample_every = 211      # 素数。命令の並びと共鳴しない
    text_end = tvm + len(code)
    fs_set = set(fs)
    for ins in md.disasm(code, tvm):
        insn_count += 1
        if insn_count % sample_every == 0:
            sample_insns.append([ins.address, ins.mnemonic, ins.op_str])
        mn = ins.mnemonic
        kinds[mn] += 1
        if mn == 'bl':
            try:
                calls.append((ins.address, int(ins.op_str.strip().lstrip('#'), 0)))
            except ValueError:
                pass
        elif mn == 'b' or mn.startswith('b.') or mn in ('cbz', 'cbnz', 'tbz', 'tbnz'):
            branches += 1
        # adrp で組んだアドレスを追う。
        #
        # 大事なのは「レジスタが書き換えられたら忘れる」こと。忘れないと、
        #   adrp x8, page   …（ずっと後）…   ldr x8, [x8, #0x10]
        # のような無関係な組を拾って、存在しない参照を正解表に載せてしまう。
        # 書き換えたレジスタは capstone に教えてもらう（推測しない）。
        written = written_regs(mn, ins.op_str)
        if mn == 'adrp':
            try:
                r, imm = [x.strip() for x in ins.op_str.split(',')]
                adrp_reg[reg_x(r)] = int(imm.lstrip('#'), 0)
                written.discard(reg_x(r))
            except ValueError:
                pass
        elif mn == 'add' and ',' in ins.op_str:
            parts = [x.strip() for x in ins.op_str.split(',')]
            if len(parts) == 3 and parts[2].startswith('#') and adrp_reg.get(reg_x(parts[1])) is not None:
                base = adrp_reg[reg_x(parts[1])]
                adr_targets[ins.address] = base + int(parts[2][1:], 0)
                adrp_reg[reg_x(parts[0])] = adr_targets[ins.address]
                written.discard(reg_x(parts[0]))
        elif mn in ('ldr', 'ldrsw', 'ldrb', 'ldrh', 'ldrsb', 'ldrsh') and '[' in ins.op_str:
            m = re.match(r'(\w+), \[(\w+)(?:, #(-?0x[0-9a-fA-F]+|-?\d+))?\]$', ins.op_str)
            if m and adrp_reg.get(reg_x(m.group(2))) is not None:
                base = adrp_reg[reg_x(m.group(2))]
                adr_targets[ins.address] = base + (int(m.group(3).lstrip('#'), 0) if m.group(3) else 0)
        for r in written:
            adrp_reg.pop(r, None)
    say('  insns %d calls %d adr %d' % (insn_count, len(calls), len(adr_targets)))

    # 文字列（cstring 系すべて）
    say('strings…')
    strings = {}
    for (seg, name), sec in img.sections.items():
        if 'cstring' in name or name in ('__objc_methname', '__objc_classname', '__oslogstring', '__objc_methtype'):
            blob = img.buf[sec.offset: sec.offset + sec.size]
            pos = 0
            while pos < len(blob):
                e = blob.find(b'\0', pos)
                if e < 0:
                    break
                if e > pos:
                    try:
                        strings[sec.virtual_address + pos] = blob[pos:e].decode('utf-8')
                    except UnicodeDecodeError:
                        pass
                pos = e + 1
    say('  %d' % len(strings))

    # 文字列の参照元（adrp+add が cstring を指しているもの）
    xref = defaultdict(list)
    for site, tgt in adr_targets.items():
        if tgt in strings:
            xref[tgt].append(site)

    say('writing…')
    doc = {
        'file': os.path.basename(path),
        'base': img.base,
        'text': {'vm': tvm, 'size': len(code)},
        'sections': [{'seg': k[0], 'sec': k[1], 'vm': v.virtual_address, 'size': v.size,
                      'off': v.offset} for k, v in img.sections.items()],
        'functionStarts': fs,
        'symbols': {str(k): v for k, v in syms.items()},
        'stubs': {str(k): v for k, v in stubs.items()},
        'objcStubs': {str(k): v for k, v in objc_stubs.items()},
        'objcClasses': classes,
        'insnCount': insn_count,
        'mnemonics': dict(kinds),
        'calls': calls,
        'adrTargets': {str(k): v for k, v in adr_targets.items()},
        'sampleInsns': sample_insns,
        'strings': {str(k): v for k, v in strings.items()},
        'stringXrefs': {str(k): v for k, v in xref.items()},
    }
    with gzip.open(out_path, 'wt', encoding='utf-8') as f:
        json.dump(doc, f)
    say('wrote %s (%.1f MB)' % (out_path, os.path.getsize(out_path) / 1e6))


if __name__ == '__main__':
    main()
