from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'{path}: expected one match, found {n}')
    p.write_text(text.replace(old, new, 1))

replace_once('js/binary/source-reader.js',
"""export async function parseSourceRanges(source, parser, parserOptions = {}, options = {}) {
""",
"""function throwIfSourceAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('binary metadata read aborted');
  error.name = 'AbortError';
  error.code = 'BYTE_SOURCE_CANCELLED';
  throw error;
}

export async function parseSourceRanges(source, parser, parserOptions = {}, options = {}) {
""")

replace_once('js/binary/source-reader.js',
"""  for (;;) {
    try {
      // Parsers remain synchronous. On a cache miss we fetch a bounded range
""",
"""  for (;;) {
    throwIfSourceAborted(options.signal);
    try {
      // Parsers remain synchronous. On a cache miss we fetch a bounded range
""")

replace_once('js/binary/source-reader.js',
"""      const image = parser(sparse, parserOptions);
      image.attachSource(source, { discardBytes: true });
""",
"""      const image = parser(sparse, parserOptions);
      throwIfSourceAborted(options.signal);
      image.attachSource(source, { discardBytes: true });
""")

replace_once('js/binary/source-reader.js',
"""    } catch (error) {
      if (error?.code !== 'BINARY_SOURCE_RANGE_MISSING') throw error;
      const missingEnd = error.offset + error.length > source.size ? source.size : error.offset + error.length;
""",
"""    } catch (error) {
      if (error?.code !== 'BINARY_SOURCE_RANGE_MISSING') throw error;
      throwIfSourceAborted(options.signal);
      const missingEnd = error.offset + error.length > source.size ? source.size : error.offset + error.length;
""")

replace_once('js/binary/source-reader.js',
"""        if (++reads > maxReads) throw new ByteSourceLimitError(`binary metadata required more than ${maxReads} range reads`);
        if (options.signal?.aborted) {
          const cancelled = new Error('binary metadata read aborted');
          cancelled.name = 'AbortError';
          throw cancelled;
        }
""",
"""        throwIfSourceAborted(options.signal);
        if (++reads > maxReads) throw new ByteSourceLimitError(`binary metadata required more than ${maxReads} range reads`);
""")

replace_once('js/binary/source-reader.js',
"""        const bytes = await source.readExactly(cursor, length, { signal: options.signal });
        const added = sparse.additionalBytes(cursor, bytes.byteLength);
""",
"""        const bytes = await source.readExactly(cursor, length, { signal: options.signal });
        throwIfSourceAborted(options.signal);
        const added = sparse.additionalBytes(cursor, bytes.byteLength);
""")

# Loader propagation, including prefix/fat-table reads.
p = Path('js/binary/source-loaders.js')
t = p.read_text()
t = t.replace("const prefix = await source.readExactly(0n, prefixLength);", "const prefix = await source.readExactly(0n, prefixLength, { signal:opts.signal });", 1)
t = t.replace("const rangeOptions = opts.ranges || {};", "const rangeOptions = { ...(opts.ranges || {}), signal:(opts.ranges || {}).signal ?? opts.signal };", 1)
t = t.replace("const image = await parseSourceRanges(source, parseELF, {}, withInitial(magic, rangeOptions));", "const image = await parseSourceRanges(source, parseELF, {}, withInitial(magic, { ...rangeOptions, signal:rangeOptions.signal ?? opts.signal }));", 1)
t = t.replace("const image = await parseSourceRanges(source, parsePE, {}, withInitial(magic, rangeOptions));", "const image = await parseSourceRanges(source, parsePE, {}, withInitial(magic, { ...rangeOptions, signal:rangeOptions.signal ?? opts.signal }));", 1)
t = t.replace("const magic = prefix || await source.readExactly(0n, Number(source.size < 16n ? source.size : 16n));", "const magic = prefix || await source.readExactly(0n, Number(source.size < 16n ? source.size : 16n), { signal:opts.signal });", 1)
t = t.replace("const image = await parseSourceRanges(source, parseMachO, opts, withInitial(magic, rangeOptions));", "const image = await parseSourceRanges(source, parseMachO, opts, withInitial(magic, { ...rangeOptions, signal:rangeOptions.signal ?? opts.signal }));", 1)
t = t.replace("const head = magic.byteLength >= 8 ? magic.subarray(0, 8) : await source.readExactly(0n, 8);", "const head = magic.byteLength >= 8 ? magic.subarray(0, 8) : await source.readExactly(0n, 8, { signal:opts.signal });", 1)
t = t.replace("const table = await source.readExactly(8n, tableSize);", "const table = await source.readExactly(8n, tableSize, { signal:opts.signal });", 1)
t = t.replace("const slicePrefix = await readPrefix(sliceSource);", "const slicePrefix = await readPrefix(sliceSource, opts.signal);", 1)
t = t.replace("const image = await parseSourceRanges(sliceSource, parseMachO, { ...opts, containerOffset: selected.offset }, withInitial(slicePrefix, rangeOptions));", "const image = await parseSourceRanges(sliceSource, parseMachO, { ...opts, containerOffset:selected.offset }, withInitial(slicePrefix, { ...rangeOptions, signal:rangeOptions.signal ?? opts.signal }));", 1)
t = t.replace("async function readPrefix(source) {\n  return source.readExactly(0n, Number(source.size < 16n ? source.size : 16n));\n}", "async function readPrefix(source, signal = null) {\n  return source.readExactly(0n, Number(source.size < 16n ? source.size : 16n), { signal });\n}")
# Thin ELF/PE helper prefix calls.
t = t.replace("const magic = prefix || await readPrefix(source);", "const magic = prefix || await readPrefix(source, opts.signal);", 2)
p.write_text(t)

replace_once('package.json',
"""\"binary:source-test\": \"node tests/universal-binary-source.mjs""",
"""\"binary:source-test\": \"node tests/issue-466-source-abort.mjs && node tests/universal-binary-source.mjs""")
