#!/usr/bin/env python3
"""Normalize oracle references/ObjC layout with independent static trust rules.

The production worker deliberately stopped carrying ADRP state across control-flow
boundaries in #556. The original Python oracle could still combine an ADRP from
one path/function with a later ADD/LDR, including 32-bit W-register arithmetic,
and label a fabricated reference as truth.

This pass keeps the oracle independent (LIEF + Python Capstone) while applying
architectural lifetime/width rules, mapped-VM validation, and static ObjC ivar
layout sanity. Runtime-populated Swift ivar offsets are not exact static truth.
"""
import gzip
import json
import re
import sys

import lief
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM

from cross_binary_oracle_hardening import mapped_vm, normalize_objc_ivars

_REGX = re.compile(r'^[wx](\d+)$')
_REGX64 = re.compile(r'^x(\d+)$')
_MEM = re.compile(r'(\w+), \[(\w+)(?:, #(-?0x[0-9a-fA-F]+|-?\d+))?\]$')
_NO_WRITE = {
    'cmp', 'cmn', 'tst', 'fcmp', 'fcmpe', 'ccmp', 'ccmn',
    'b', 'bl', 'br', 'blr', 'braa', 'brab', 'blraa', 'blrab',
    'cbz', 'cbnz', 'tbz', 'tbnz', 'ret', 'retaa', 'retab',
    'nop', 'hint', 'bti', 'dmb', 'dsb', 'isb', 'svc', 'brk', 'udf', 'hlt',
    'msr', 'sys', 'pacibsp', 'autibsp', 'paciasp', 'autiasp', 'prfm',
}
_WB = re.compile(r'\[(\w+)[^\]]*\]!|\[(\w+)\],')
_LOADS = {'ldr', 'ldrsw', 'ldrb', 'ldrh', 'ldrsb', 'ldrsh'}


def reg_x(name):
    m = _REGX.match(name or '')
    return 'x' + m.group(1) if m else name


def written_regs(mn, ops):
    out = set()
    m = _WB.search(ops)
    if m:
        out.add(reg_x(m.group(1) or m.group(2)))
    if mn in _NO_WRITE or mn.startswith('b.'):
        return out
    if mn.startswith('st') and not mn.startswith(('stx', 'stlx')):
        return out
    parts = [p.strip() for p in ops.split(',')]
    n = 2 if mn.startswith(('ldp', 'ldnp', 'ldxp')) else 1
    for p in parts[:n]:
        if _REGX.match(p):
            out.add(reg_x(p))
    return out


def branch_target(ops):
    token = (ops.split(',')[-1].strip() if ops else '').lstrip('#')
    try:
        return int(token, 0)
    except ValueError:
        return None


def load_doc(path):
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        return json.load(f)


def save_doc(path, doc):
    with gzip.open(path, 'wt', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))


def text_image(path):
    raw = open(path, 'rb').read()
    image = lief.MachO.parse(path).at(0)
    text = None
    for section in image.sections:
        if section.segment_name == '__TEXT' and section.name == '__text':
            text = section
            break
    if text is None:
        raise RuntimeError('missing __TEXT,__text')
    code = raw[text.offset:text.offset + text.size]
    return image, text.virtual_address, code


def cfg_safe_adr_targets(binary, function_starts):
    image, tvm, code = text_image(binary)
    text_end = tvm + len(code)
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    md.detail = False
    md.skipdata = True

    starts = {int(x) for x in function_starts}
    forward_entries = set()
    bases = {}
    out = {}

    for ins in md.disasm(code, tvm):
        pc = ins.address
        mn = ins.mnemonic
        ops = ins.op_str

        # Skipdata/undecodable words are provenance barriers. We do not know
        # what registers the skipped bytes would define, so carrying an ADRP
        # through them would manufacture certainty.
        if mn.startswith('.'):
            bases.clear()
            continue

        # A register value from another function or predecessor is not local
        # evidence for this path.
        if pc in starts or pc in forward_entries:
            bases.clear()

        written = written_regs(mn, ops)
        propagated = None

        if mn == 'adrp':
            try:
                dst, imm = [x.strip() for x in ops.split(',')]
                if not _REGX64.match(dst):
                    raise ValueError('ADRP destination is not X register')
                bases[dst] = int(imm.lstrip('#'), 0)
                written.discard(dst)
                propagated = dst
            except (ValueError, TypeError):
                pass
        elif mn == 'add':
            parts = [x.strip() for x in ops.split(',')]
            # ADRP+ADD is a 64-bit address materialisation. A W-register ADD
            # truncates to 32 bits and must never inherit X-register provenance.
            if (len(parts) == 3 and parts[2].startswith('#') and
                    _REGX64.match(parts[0]) and _REGX64.match(parts[1])):
                src = parts[1]
                if src in bases:
                    try:
                        target = bases[src] + int(parts[2][1:], 0)
                        dst = parts[0]
                        if mapped_vm(image, target):
                            out[pc] = target
                            bases[dst] = target
                            written.discard(dst)
                            propagated = dst
                        else:
                            bases.pop(dst, None)
                    except ValueError:
                        pass
        elif mn in _LOADS and '[' in ops:
            m = _MEM.match(ops)
            if m:
                base_text = m.group(2)
                base = reg_x(base_text)
                if _REGX64.match(base_text) and base in bases:
                    off = int(m.group(3), 0) if m.group(3) else 0
                    target = bases[base] + off
                    if mapped_vm(image, target):
                        out[pc] = target

        for reg in written:
            if reg != propagated:
                bases.pop(reg, None)

        target = branch_target(ops)
        in_text_forward = target is not None and pc < target < text_end
        if mn == 'bl' or mn.startswith('blr'):
            for i in range(19):
                bases.pop('x%d' % i, None)
        elif mn == 'b':
            if in_text_forward:
                forward_entries.add(target)
            bases.clear()
        elif mn.startswith('b.') or mn in ('cbz', 'cbnz', 'tbz', 'tbnz'):
            if in_text_forward:
                forward_entries.add(target)
        elif mn in ('br', 'braa', 'brab', 'ret', 'retaa', 'retab', 'brk', 'udf', 'hlt'):
            bases.clear()

    return out


def main():
    if len(sys.argv) != 3:
        print('usage: oracle-cfg-normalize.py <binary> <oracle.json.gz>', file=sys.stderr)
        return 2
    binary, oracle_path = sys.argv[1:]
    doc = load_doc(oracle_path)
    safe = cfg_safe_adr_targets(binary, doc.get('functionStarts', []))
    strings = set((doc.get('strings') or {}).keys())
    xrefs = {}
    for site, target in safe.items():
        key = str(target)
        if key in strings:
            xrefs.setdefault(key, []).append(site)
    before = len(doc.get('adrTargets') or {})
    doc['adrTargets'] = {str(site): target for site, target in safe.items()}
    doc['stringXrefs'] = {key: sites for key, sites in xrefs.items()}
    dropped_ivars = normalize_objc_ivars(doc)
    doc['addressProvenanceOracle'] = 'cfg-aware-aapcs64-v2'
    doc['objcIvarOracle'] = 'static-layout-trusted-v1'
    save_doc(oracle_path, doc)
    print(
        'cfg-normalized adrTargets %d -> %d; string targets %d; dropped untrusted ivars %d'
        % (before, len(safe), len(xrefs), dropped_ivars),
        file=sys.stderr,
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
