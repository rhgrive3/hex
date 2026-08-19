#!/usr/bin/env python3
from cross_binary_oracle_hardening import trusted_ivar_offset


def test_static_ivar_offsets():
    assert trusted_ivar_offset(0, 16)
    assert trusted_ivar_offset(8, 16)
    assert not trusted_ivar_offset(16, 16)
    assert not trusted_ivar_offset(0x100001, 0x200000)
    assert not trusted_ivar_offset(None, 16)


if __name__ == '__main__':
    test_static_ivar_offsets()
