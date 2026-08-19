#!/usr/bin/env python3
"""Generic trust predicates for the real-binary cross-binary oracle.

This module deliberately does not know fixture names or addresses.  It keeps
only facts that a static Mach-O oracle can prove: VM targets must be mapped and
Objective-C ivar offsets must fit the statically declared instance layout.
"""

IVAR_OFFSET_SANITY_CAP = 0x100000


def mapped_vm(image, address):
    if address is None:
        return False
    value = int(address)
    for segment in image.segments:
        start = int(segment.virtual_address)
        size = int(segment.virtual_size)
        if size > 0 and start <= value < start + size:
            return True
    return False


def trusted_ivar_offset(offset, instance_size):
    if offset is None:
        return False
    value = int(offset)
    size = int(instance_size or 0)
    if value < 0 or value > IVAR_OFFSET_SANITY_CAP:
        return False
    # class_ro_t instanceSize is the complete statically allocated object size.
    # An ivar beginning at/after that boundary is not a valid static offset.
    if size > 0 and value >= size:
        return False
    return True


def normalize_objc_ivars(doc):
    dropped = 0
    for cls in doc.get('objcClasses') or []:
        size = cls.get('instanceSize')
        ivars = cls.get('ivars') or []
        kept = []
        for ivar in ivars:
            if trusted_ivar_offset(ivar.get('offset'), size):
                kept.append(ivar)
            else:
                dropped += 1
        cls['ivars'] = kept
    return dropped
