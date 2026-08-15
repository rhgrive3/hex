from pathlib import Path


def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

# #475: explicit verification state must never be overwritten by a default true.
p = Path('js/platform/describe.js')
s = p.read_text()
s = replace_once(s,
"""  const engine = {\n    ...DEPLOYED_CAPSTONE_SUPPORT,\n    ...(options.engine || {}),\n    verified: true,\n  };""",
"""  const requestedEngine = options.engine || {};\n  const engine = {\n    ...DEPLOYED_CAPSTONE_SUPPORT,\n    ...requestedEngine,\n    // A bundled decoder being known-compatible is not the same thing as this\n    // runtime instance having completed its probe. Verification is opt-in.\n    verified: requestedEngine.verified === true,\n  };""", 'verified trust boundary')
s = replace_once(s,
"""    cpu: image.arch || 'unknown',\n    cpuSub: 'all',\n    is64: image.bits === 64,\n    isArm64: image.arch === 'arm64',""",
"""    cpu: image.arch || 'unknown',\n    cpuSub: image.metadata?.subtypeName || (image.metadata?.subtypeBase == null ? 'all' : String(image.metadata.subtypeBase)),\n    is64: image.bits === 64,\n    isArm64: image.arch === 'arm64' || image.arch === 'arm64e',\n    isArm64e: image.arch === 'arm64e',""", 'descriptor subtype')
p.write_text(s)

# The deployed Capstone ARM64 decoder can decode ARM64e instruction encodings;
# semantic analysis capability is separately marked partial below.
p = Path('js/platform/capstone-capability.js')
s = p.read_text()
s = replace_once(s,
"""export const DEPLOYED_CAPSTONE_SUPPORT = Object.freeze({\n  arm64: true,\n  x86_64: true,\n});""",
"""export const DEPLOYED_CAPSTONE_SUPPORT = Object.freeze({\n  arm64: true,\n  arm64e: true,\n  x86_64: true,\n});""", 'capstone arm64e support')
p.write_text(s)

# #474: architecture identity/capability must preserve ARM64e as a distinct,
# explicitly partial semantic target rather than silently claiming generic ARM64.
p = Path('js/architecture/index.js')
s = p.read_text()
s = replace_once(s,
"""  const engineSupported = !!engine[architecture];\n  const arm64Analysis = architecture === 'arm64' && engineSupported;\n  const emulationSupported = !!engine.emulation?.[architecture];\n  return Object.freeze({\n    format: image?.format || 'unknown', architecture, endianness: image?.endian || 'unknown', bits: Number(image?.bits || 0),\n    canDisassemble: engineSupported, canAnalyzeDataflow: arm64Analysis, canEmulate: emulationSupported,\n    viewerCanDisassemble: engineSupported && !!adapter.viewerCompatible,\n    instructionAlignment: adapter.instructionAlignment, fixedInstructionSize: adapter.fixedInstructionSize, engineVerified: !!engine.verified,\n  });""",
"""  const engineSupported = !!engine[architecture] || (architecture === 'arm64e' && !!engine.arm64);\n  const arm64Analysis = (architecture === 'arm64' || architecture === 'arm64e') && engineSupported;\n  const emulationSupported = !!engine.emulation?.[architecture];\n  const analysisLevel = arm64Analysis ? (architecture === 'arm64e' ? 'partial' : 'full') : 'unsupported';\n  return Object.freeze({\n    format: image?.format || 'unknown', architecture, endianness: image?.endian || 'unknown', bits: Number(image?.bits || 0),\n    canDisassemble: engineSupported, canAnalyzeDataflow: arm64Analysis, canEmulate: emulationSupported,\n    viewerCanDisassemble: engineSupported && !!adapter.viewerCompatible,\n    instructionAlignment: adapter.instructionAlignment, fixedInstructionSize: adapter.fixedInstructionSize, engineVerified: !!engine.verified,\n    analysisLevel, partial: analysisLevel === 'partial',\n    limitations: architecture === 'arm64e' ? Object.freeze(['pointer-authentication data semantics are conservative']) : Object.freeze([]),\n  });""", 'arm64e capability')
s = replace_once(s,
"""registerArchitectureAdapter({\n  id: 'arm64', instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true,""",
"""const ARM64_ADAPTER = registerArchitectureAdapter({\n  id: 'arm64', instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true,""", 'capture arm64 adapter')
anchor = """registerArchitectureAdapter({\n  id: 'x86_64', instructionAlignment: 1, fixedInstructionSize: null, viewerCompatible: false,"""
insert = """registerArchitectureAdapter({\n  id: 'arm64e', instructionAlignment: ARM64_ADAPTER.instructionAlignment, fixedInstructionSize: ARM64_ADAPTER.fixedInstructionSize,\n  viewerCompatible: ARM64_ADAPTER.viewerCompatible, assemble: ARM64_ADAPTER.assemble,\n  controlFlow: ARM64_ADAPTER.controlFlow, callKind: ARM64_ADAPTER.callKind, returnKind: ARM64_ADAPTER.returnKind,\n});\n\n""" + anchor
s = replace_once(s, anchor, insert, 'arm64e adapter')
p.write_text(s)

p = Path('js/binary/macho.js')
s = p.read_text()
s = replace_once(s,
"""  const image = new BinaryImage(bytes, {\n    format: 'macho', arch: cpuName(cpu), bits,\n    endian: kind.littleEndian ? 'little' : 'big',\n    platform: 'apple', imageBase: 0n,\n    fileOffset: opts.containerOffset || 0n,\n    metadata: { cpu, subtype, filetype, flags, ncmds, sizeofcmds },\n  });""",
"""  const arch = cpuArchName(cpu, subtype);\n  const image = new BinaryImage(bytes, {\n    format: 'macho', arch, bits,\n    endian: kind.littleEndian ? 'little' : 'big',\n    platform: 'apple', imageBase: 0n,\n    fileOffset: opts.containerOffset || 0n,\n    metadata: {\n      cpu, subtype, cpuName: cpuName(cpu), subtypeBase: subtypeBase(subtype),\n      subtypeName: arch === 'arm64e' ? 'arm64e' : String(subtypeBase(subtype)),\n      filetype, flags, ncmds, sizeofcmds,\n    },\n  });""", 'thin architecture identity')
s = replace_once(s,
"""function subtypeBase(subtype) { return (subtype >>> 0) & 0x00ffffff; }\nfunction sliceArchName(slice) { return cpuName(slice.cpu) === 'arm64' && subtypeBase(slice.subtype) === 2 ? 'arm64e' : cpuName(slice.cpu); }""",
"""function subtypeBase(subtype) { return (subtype >>> 0) & 0x00ffffff; }\nfunction cpuArchName(cpu, subtype) { return cpuName(cpu) === 'arm64' && subtypeBase(subtype) === 2 ? 'arm64e' : cpuName(cpu); }\nfunction sliceArchName(slice) { return cpuArchName(slice.cpu, slice.subtype); }""", 'canonical subtype architecture')
p.write_text(s)

p = Path('js/platform/worker.js')
s = p.read_text()
s = replace_once(s,
"""    const engine = { arm64: candidateImage.arch === 'arm64', verified: false };""",
"""    const engine = {\n      arm64: candidateImage.arch === 'arm64' || candidateImage.arch === 'arm64e',\n      arm64e: candidateImage.arch === 'arm64e',\n      verified: false,\n    };""", 'worker engine identity')
p.write_text(s)

# #473: function-start identity and function-extent evidence are independent.
p = Path('js/binary/model.js')
s = p.read_text()
start = s.index('export function functionSeed(address, opts = {}) {')
end = s.index('\n\nexport function mergeFunctionSeeds', start)
new_seed = r'''export function functionSeed(address, opts = {}) {
  const source = opts.source || 'heuristic';
  const confidence = Math.max(0, Math.min(1, Number(opts.confidence ?? 0.5)));
  const size = opts.size == null ? null : BigInt(opts.size);
  const end = opts.end == null ? null : BigInt(opts.end);
  const hasExtent = size != null || end != null;
  return {
    address: BigInt(address),
    size,
    end,
    name: opts.name || null,
    source,
    confidence,
    kind: opts.kind || 'function',
    extentSource: opts.extentSource || (hasExtent ? source : null),
    extentConfidence: opts.extentConfidence == null ? (hasExtent ? confidence : null)
      : Math.max(0, Math.min(1, Number(opts.extentConfidence))),
    extentInherited: !!opts.extentInherited,
  };
}'''
s = s[:start] + new_seed + s[end:]
s = replace_once(s,
"""    const f = { ...f0, address: BigInt(f0.address) };\n    const k = f.address.toString();""",
"""    const f = { ...f0, address: BigInt(f0.address) };\n    if ((f.size != null || f.end != null) && !f.extentSource) f.extentSource = f.source || 'unknown';\n    if ((f.size != null || f.end != null) && f.extentConfidence == null) f.extentConfidence = Number(f.confidence ?? 0);\n    const k = f.address.toString();""", 'normalize extent provenance')
s = replace_once(s,
"""    if (!best.name && other.name) best.name = other.name;\n    if (best.size == null && other.size != null) best.size = other.size;\n    if (best.end == null && other.end != null) best.end = other.end;\n    best.sources = [...new Set([...(prev.sources || [prev.source]), ...(f.sources || [f.source])])];""",
"""    if (!best.name && other.name) best.name = other.name;\n    let inheritedExtent = false;\n    if (best.size == null && other.size != null) { best.size = other.size; inheritedExtent = true; }\n    if (best.end == null && other.end != null) { best.end = other.end; inheritedExtent = true; }\n    if (inheritedExtent) {\n      best.extentSource = other.extentSource || other.source || 'unknown';\n      best.extentConfidence = Number(other.extentConfidence ?? other.confidence ?? 0);\n      best.extentInherited = true;\n      best.extentSources = [...new Set([...(best.extentSources || (best.extentSource ? [best.extentSource] : [])), other.extentSource || other.source].filter(Boolean))];\n    } else if ((best.size != null || best.end != null) && !best.extentSource) {\n      best.extentSource = best.source || 'unknown';\n      best.extentConfidence = Number(best.confidence ?? 0);\n    }\n    best.sources = [...new Set([...(prev.sources || [prev.source]), ...(f.sources || [f.source])])];""", 'inherit extent with provenance')
p.write_text(s)

# Keep the focused regression in the platform gate.
p = Path('package.json')
s = p.read_text()
needle = '"platform:test": "'
if 'node tests/issues-473-475-platform.mjs' not in s:
    at = s.index(needle) + len(needle)
    s = s[:at] + 'node tests/issues-473-475-platform.mjs && ' + s[at:]
p.write_text(s)
