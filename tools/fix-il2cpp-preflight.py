from pathlib import Path
p=Path('js/il2cpp.js')
s=p.read_text()
helper="""function assertMetadataPreflight(buffer, options = {}) {
  const bytes = buffer?.byteLength ?? buffer?.length ?? 0;
  const max = options.budget?.maxInputBytes ?? options.metadataBudget?.maxInputBytes ?? MAX_IL2CPP_METADATA_BYTES;
  if (options.signal?.aborted) throw budgetError('ABORT_ERR', 'IL2CPP metadata parsing was cancelled.');
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > max) throw budgetError('IL2CPP_METADATA_BUDGET', `global-metadata.dat is too large (${bytes} bytes).`);
  return bytes;
}
"""
anchor="function metadataBudget(options = {}, inputBytes = 0) {"
if 'function assertMetadataPreflight' not in s:
    s=s.replace(anchor,helper+anchor,1)
s=s.replace("export function parseMetadata(buffer,options={}){\n  const ctx0=headerContext(buffer), warnings=[];","export function parseMetadata(buffer,options={}){\n  assertMetadataPreflight(buffer,options);\n  const ctx0=headerContext(buffer), warnings=[];")
s=s.replace("export function parseMetadataAuto(buffer,options={}){\n  const ctx=headerContext(buffer);","export function parseMetadataAuto(buffer,options={}){\n  assertMetadataPreflight(buffer,options);\n  const ctx=headerContext(buffer);")
p.write_text(s)
