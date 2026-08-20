export function auditBinary(image) {
  const issues = [];
  const stats = {
    mappedSegments: 0,
    mappedSections: 0,
    roundTrips: 0,
    importSites: 0,
    executableFunctions: 0,
    unmappedFunctions: 0,
  };

  for (const seg of image.segments) {
    if (seg.fileSize > 0n) {
      stats.mappedSegments++;
      checkFileRange(image, seg.fileOffset, seg.fileSize, `segment ${seg.name}`, issues);
      checkRoundTrip(image, seg.address, seg.fileOffset, `segment ${seg.name}`, stats, issues);
      if (seg.fileSize > 1n) checkRoundTrip(image, seg.address + seg.fileSize - 1n, seg.fileOffset + seg.fileSize - 1n, `segment ${seg.name} end`, stats, issues);
    }
    if (seg.fileSize > seg.size) issues.push(issue('warning', 'segment-file-larger-than-vm', `${seg.name}: file size exceeds memory size`));
  }

  for (const sec of image.sections) {
    if (sec.fileSize > 0n) {
      checkFileRange(image, sec.fileOffset, sec.fileSize, `section ${sec.name}`, issues);
      if (sec.address !== 0n) {
        stats.mappedSections++;
        checkRoundTrip(image, sec.address, sec.fileOffset, `section ${sec.name}`, stats, issues);
      }
    }
  }

  const functionAddresses = new Set();
  for (const f of image.functions) {
    const key = f.address.toString();
    if (functionAddresses.has(key)) issues.push(issue('error', 'duplicate-function', `duplicate function at ${hex(f.address)}`));
    functionAddresses.add(key);
    const sec = image.sectionAt(f.address) || image.segmentAt(f.address);
    if (sec && sec.perms.execute) stats.executableFunctions++;
    else {
      stats.unmappedFunctions++;
      if (f.source !== 'entrypoint') issues.push(issue('warning', 'function-outside-exec', `${hex(f.address)} (${f.source}) is outside executable mapped memory`));
    }
    if (f.size != null && f.size < 0n) issues.push(issue('error', 'negative-function-size', `${hex(f.address)} has a negative size`));
  }

  for (const imp of image.imports) {
    for (const site of imp.sites || []) {
      stats.importSites++;
      if (site.address != null && image.addressToOffset(site.address) == null) {
        issues.push(issue('warning', 'unmapped-import-site', `${imp.name || '#'+imp.ordinal} site ${hex(site.address)} cannot be mapped to the file`));
      }
    }
  }

  const unprovenZeroEntrypoint = image.entrypoint === 0n
    && image.metadata?.entrypointZeroEvidence === 'zero-sentinel-unproven';
  if (image.entrypoint != null && !unprovenZeroEntrypoint) {
    const sec = image.sectionAt(image.entrypoint) || image.segmentAt(image.entrypoint);
    if (!sec || !sec.perms.execute) issues.push(issue('warning', 'entrypoint-not-executable', `entrypoint ${hex(image.entrypoint)} is not in executable mapped memory`));
  }

  const errors = issues.filter((x) => x.level === 'error').length;
  const warnings = issues.length - errors;
  return { ok: errors === 0, errors, warnings, issues, stats, capabilities: capabilitiesOf(image) };
}

export function capabilitiesOf(image) {
  const sources = (items, field = 'source') => [...new Set((items || []).map((x) => x[field]).filter(Boolean))].sort();
  const importSites = image.imports.reduce((n, x) => n + (x.sites ? x.sites.length : 0), 0);
  return {
    format: image.format,
    architecture: image.arch,
    endianness: image.endian,
    bits: image.bits,
    addressMapping: image.segments.some((x) => x.fileSize > 0n) || image.sections.some((x) => x.fileSize > 0n),
    sections: image.sections.length,
    imports: { count: image.imports.length, sites: importSites, sources: sources(image.imports) },
    exports: { count: image.exports.length, sources: sources(image.exports) },
    symbols: { count: image.symbols.length, sources: sources(image.symbols) },
    relocations: { count: image.relocations.length, sources: sources(image.relocations) },
    functions: { count: image.functions.length, sources: sources(image.functions) },
    libraries: image.libraries.length,
  };
}

function checkFileRange(image, start, size, label, issues) {
  const fileSize = image.fileSize != null ? BigInt(image.fileSize) : BigInt(image.bytes?.length || 0);
  if (start < 0n || size < 0n || start > fileSize || size > fileSize - start) {
    issues.push(issue('error', 'file-range-outside', `${label}: [${hex(start)}, ${hex(start + size)}) exceeds file size ${hex(fileSize)}`));
  }
}

function checkRoundTrip(image, address, offset, label, stats, issues) {
  const gotOffset = image.addressToOffset(address);
  const gotAddress = image.offsetToAddress(offset);
  stats.roundTrips++;
  if (gotOffset !== offset) issues.push(issue('error', 'address-offset-roundtrip', `${label}: ${hex(address)} -> ${hex(gotOffset)} expected ${hex(offset)}`));
  if (gotAddress !== address) issues.push(issue('error', 'offset-address-roundtrip', `${label}: ${hex(offset)} -> ${hex(gotAddress)} expected ${hex(address)}`));
}

function issue(level, code, message) { return { level, code, message }; }
function hex(v) { return v == null ? 'null' : '0x' + BigInt(v).toString(16).toUpperCase(); }
