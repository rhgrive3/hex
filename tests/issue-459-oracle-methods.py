#!/usr/bin/env python3
import importlib.util
import struct
import sys
import types

# oracle.py's parsing helpers are unit-tested without requiring external LIEF/Capstone.
lief = types.ModuleType('lief')
lief.MachO = types.SimpleNamespace(parse=lambda _: None)
sys.modules['lief'] = lief
capstone = types.ModuleType('capstone')
capstone.Cs = object
capstone.CS_ARCH_ARM64 = 0
capstone.CS_MODE_ARM = 0
sys.modules['capstone'] = capstone

spec = importlib.util.spec_from_file_location('hex_oracle', 'tests/oracle.py')
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)

class FakeImage:
    def __init__(self, base, payload, strings):
        self.base = base
        self.payload = payload
        self.strings = strings
    def read(self, vm, n):
        off = vm - self.base
        if 0 <= off and off + n <= len(self.payload):
            return self.payload[off:off+n]
        return None
    def u64(self, vm):
        b = self.read(vm, 8)
        return struct.unpack('<Q', b)[0] if b else None
    def off(self, vm):
        if self.base <= vm < self.base + len(self.payload) or vm in self.strings:
            return vm
        return None
    def cstr(self, vm, limit=512):
        return self.strings.get(vm)

base = 0x1000
# Relative small method list: header + one 12-byte entry.
# name relative offset is relative to the name field address p.
p = base + 8
imp = base + 0x30

# Direct-selector form (0x40000000): p+n_off points directly at UTF-8 selector.
direct_name = base + 0x60
direct = bytearray(0x80)
struct.pack_into('<II', direct, 0, 0xC000000C, 1)  # small + direct selectors + entsize=12
struct.pack_into('<iii', direct, 8, direct_name - p, 0, imp - (p + 8))
img = FakeImage(base, bytes(direct), {direct_name: 'directSelector:'})
methods = oracle.read_methods(img, base, {})
assert methods == [{'name': 'directSelector:', 'addr': imp}], methods

# Indirect-selector form: p+n_off is a selref containing a pointer to UTF-8 selector.
sel_ref = base + 0x48
indirect_name = base + 0x70
indirect = bytearray(0x90)
struct.pack_into('<II', indirect, 0, 0x8000000C, 1)
struct.pack_into('<iii', indirect, 8, sel_ref - p, 0, imp - (p + 8))
struct.pack_into('<Q', indirect, sel_ref - base, indirect_name)
img = FakeImage(base, bytes(indirect), {indirect_name: 'indirectSelector:'})
methods = oracle.read_methods(img, base, {})
assert methods == [{'name': 'indirectSelector:', 'addr': imp}], methods

print('issue #459 ObjC small selector oracle regression passed')
