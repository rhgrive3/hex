function scalarName(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return String(value.name || value.library || value.path || value.dll || value.module || '');
}

function uniqueNames(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const name = scalarName(value).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function compactMetadata(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined || value === null) continue;
    Object.defineProperty(out, key, { value, enumerable:true, writable:true, configurable:true });
  }
  return out;
}

/** Format-neutral contract consumed by Product and legacy compatibility sheets. */
export function productDescriptor(fileInfo, slice) {
  const active = slice || fileInfo?.slices?.[0] || null;
  const embedded = fileInfo?.productDescriptor || active?.descriptor || active?.info?.descriptor || {};
  const info = active?.info || {};
  const formatId = String(embedded.formatId || fileInfo?.formatId || info.format || '').toLowerCase() || 'raw';
  const regions = Array.isArray(embedded.regions) ? embedded.regions : (active?.regions || []);
  const imports = Array.isArray(embedded.imports) ? embedded.imports : (info.imports || []);
  const exports = Array.isArray(embedded.exports) ? embedded.exports : (info.exports || []);
  const dependencies = uniqueNames([
    ...(embedded.dependencies || []),
    ...(info.dependencies || []),
    ...(info.dylibs || []),
    ...imports.map((item) => item?.library).filter(Boolean),
  ]);
  const generic = compactMetadata({
    format: formatId,
    arch: info.cpu || fileInfo?.architecture,
    bits: info.is64 === true ? 64 : info.is64 === false ? 32 : undefined,
    endian: info.endian,
    platform: info.platform,
    entrypoint: info.entry,
    imageBase: info.textVM,
  });
  return {
    formatId,
    regions,
    dependencies,
    imports,
    exports,
    formatMetadata: compactMetadata({ ...generic, ...(embedded.formatMetadata || info.formatMetadata || {}) }),
  };
}
