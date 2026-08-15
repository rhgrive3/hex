(() => {
  // js/binary/reader.js
  var MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
  function nonNegativeOffset(value, label = "offset") {
    if (typeof value === "bigint") {
      if (value < 0n) throw new TypeError(`${label} must be non-negative`);
      return value;
    }
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer or bigint`);
    return BigInt(value);
  }
  var BinaryReadError = class extends Error {
    constructor(message, offset = null) {
      let shown = null;
      if (typeof offset === "bigint" && offset >= 0n) shown = offset;
      else if (Number.isSafeInteger(offset) && offset >= 0) shown = BigInt(offset);
      super(shown == null ? message : `${message} @ 0x${shown.toString(16)}`);
      this.name = "BinaryReadError";
      this.offset = offset;
    }
  };
  var ByteView = class _ByteView {
    constructor(input, { littleEndian = true, base = 0 } = {}) {
      if (input instanceof Uint8Array) this.bytes = input;
      else if (input instanceof ArrayBuffer) this.bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) this.bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else if (input?.__binaryByteBacking === true && (typeof input.size === "bigint" || Number.isSafeInteger(input.length)) && typeof input.subarray === "function") this.bytes = input;
      else throw new TypeError("ByteView expects bytes or a binary byte backing");
      this.view = this.bytes instanceof Uint8Array ? new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength) : null;
      this.littleEndian = !!littleEndian;
      this.base = nonNegativeOffset(base, "ByteView base");
      this.lengthBigInt = typeof this.bytes.size === "bigint" ? this.bytes.size : BigInt(this.bytes.length);
    }
    get length() {
      return this.lengthBigInt > MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(this.lengthBigInt);
    }
    endian(littleEndian) {
      return new _ByteView(this.bytes, { littleEndian, base: this.base });
    }
    check(offset, size = 1) {
      const o = Number(offset);
      const n = Number(size);
      const ob = Number.isSafeInteger(o) && o >= 0 ? BigInt(o) : -1n;
      const nb = Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : -1n;
      if (ob < 0n || nb < 0n || ob > this.lengthBigInt || nb > this.lengthBigInt - ob) {
        throw new BinaryReadError(`read outside file (${n} bytes)`, this.base + (ob >= 0n ? ob : 0n));
      }
      return o;
    }
    data(offset, size) {
      const o = this.check(offset, size);
      if (this.view) return { view: this.view, offset: o };
      const bytes = this.bytes.subarray(o, o + size);
      return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
    }
    u8(offset) {
      const x = this.data(offset, 1);
      return x.view.getUint8(x.offset);
    }
    i8(offset) {
      const x = this.data(offset, 1);
      return x.view.getInt8(x.offset);
    }
    u16(offset, le = this.littleEndian) {
      const x = this.data(offset, 2);
      return x.view.getUint16(x.offset, le);
    }
    i16(offset, le = this.littleEndian) {
      const x = this.data(offset, 2);
      return x.view.getInt16(x.offset, le);
    }
    u32(offset, le = this.littleEndian) {
      const x = this.data(offset, 4);
      return x.view.getUint32(x.offset, le);
    }
    i32(offset, le = this.littleEndian) {
      const x = this.data(offset, 4);
      return x.view.getInt32(x.offset, le);
    }
    u64(offset, le = this.littleEndian) {
      const x = this.data(offset, 8);
      return x.view.getBigUint64(x.offset, le);
    }
    i64(offset, le = this.littleEndian) {
      const x = this.data(offset, 8);
      return x.view.getBigInt64(x.offset, le);
    }
    slice(offset, size) {
      const o = this.check(offset, size);
      return this.bytes.subarray(o, o + Number(size));
    }
    subview(offset, size = this.length - Number(offset), opts = {}) {
      const o = this.check(offset, size);
      return new _ByteView(this.bytes.subarray(o, o + Number(size)), {
        littleEndian: opts.littleEndian ?? this.littleEndian,
        base: this.base + BigInt(o)
      });
    }
    ascii(offset, size, { trimNul = true } = {}) {
      const b = this.slice(offset, size);
      let end = b.length;
      if (trimNul) {
        const z = b.indexOf(0);
        if (z >= 0) end = z;
      }
      let out = "";
      for (let i = 0; i < end; i++) out += String.fromCharCode(b[i]);
      return out;
    }
    cstring(offset, max = 1 << 20) {
      const o = this.check(offset, 0);
      const end = Math.min(this.length, o + Math.max(0, Number(max)));
      let raw;
      if (this.view) {
        const span = this.bytes.subarray(o, end);
        const nul = span.indexOf(0);
        raw = nul < 0 ? span : span.subarray(0, nul);
      } else {
        let p = o;
        while (p < end && this.u8(p) !== 0) p++;
        raw = this.bytes.subarray(o, p);
      }
      try {
        return new TextDecoder("utf-8", { fatal: false }).decode(raw);
      } catch {
        let out = "";
        for (const c of raw) out += c >= 32 && c <= 126 ? String.fromCharCode(c) : "�";
        return out;
      }
    }
    _lebEnd(end) {
      if (end == null) return this.length;
      const n = Number(end);
      if (!Number.isSafeInteger(n) || n < 0 || BigInt(n) > this.lengthBigInt)
        throw new BinaryReadError("invalid bounded substream end", this.base);
      return n;
    }
    uleb(offset, maxBytes = 10, end = null) {
      const start = this.check(offset, 0);
      const hardEnd = this._lebEnd(end);
      if (start > hardEnd) throw new BinaryReadError("ULEB128 starts outside bounded substream", this.base + BigInt(start));
      let p = start;
      let value = 0n;
      let shift = 0n;
      for (let i = 0; i < maxBytes; i++, p++) {
        if (p >= hardEnd) throw new BinaryReadError("ULEB128 crosses bounded substream", this.base + BigInt(p));
        this.check(p, 1);
        const b = this.u8(p);
        value |= BigInt(b & 127) << shift;
        if ((b & 128) === 0) return { value, next: p + 1, bytes: p + 1 - start };
        shift += 7n;
      }
      throw new BinaryReadError("ULEB128 is too long", this.base + BigInt(start));
    }
    sleb(offset, maxBytes = 10, end = null) {
      const start = this.check(offset, 0);
      const hardEnd = this._lebEnd(end);
      if (start > hardEnd) throw new BinaryReadError("SLEB128 starts outside bounded substream", this.base + BigInt(start));
      let p = start;
      let value = 0n;
      let shift = 0n;
      let b = 0;
      for (let i = 0; i < maxBytes; i++, p++) {
        if (p >= hardEnd) throw new BinaryReadError("SLEB128 crosses bounded substream", this.base + BigInt(p));
        this.check(p, 1);
        b = this.u8(p);
        value |= BigInt(b & 127) << shift;
        shift += 7n;
        if ((b & 128) === 0) {
          if (shift < 64n && b & 64) value |= -1n << shift;
          return { value, next: p + 1, bytes: p + 1 - start };
        }
      }
      throw new BinaryReadError("SLEB128 is too long", this.base + BigInt(start));
    }
  };
  function inRange(value, start, size) {
    const v = BigInt(value);
    const s = BigInt(start);
    const n = BigInt(size);
    return n > 0n && v >= s && v < s + n;
  }

  // js/binary/detect.js
  function detectBinary(input) {
    const r = new ByteView(input, { littleEndian: true });
    if (r.length >= 4) {
      const b0 = r.u8(0), b1 = r.u8(1), b2 = r.u8(2), b3 = r.u8(3);
      if (b0 === 127 && b1 === 69 && b2 === 76 && b3 === 70) return { format: "elf" };
      if (b0 === 77 && b1 === 90) return { format: "pe" };
      const le = r.u32(0, true);
      const be = r.u32(0, false);
      const macho = /* @__PURE__ */ new Set([4277009102, 4277009103, 3472551422, 3489328638]);
      const fat = /* @__PURE__ */ new Set([3405691582, 3405691583, 3199925962, 3216703178]);
      if (macho.has(le) || macho.has(be)) return { format: "macho", fat: false };
      if (fat.has(le) || fat.has(be)) return { format: "macho", fat: true };
    }
    return { format: "unknown" };
  }

  // js/binary/model.js
  function bigintOrNull(v) {
    if (v == null) return null;
    return typeof v === "bigint" ? v : BigInt(v);
  }
  function normalizePerms(p) {
    if (!p) return { read: false, write: false, execute: false };
    return { read: !!p.read, write: !!p.write, execute: !!p.execute };
  }
  var BinaryImage = class {
    constructor(input, meta = {}) {
      if (input == null) this.bytes = null;
      else if (input instanceof Uint8Array) this.bytes = input;
      else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) this.bytes = new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
      else if (input.__binaryByteBacking === true) this.bytes = input;
      else throw new TypeError("BinaryImage expects bytes or a binary byte backing");
      this.source = meta.source || null;
      this.format = meta.format || "unknown";
      this.arch = meta.arch || "unknown";
      this.bits = meta.bits || 0;
      this.endian = meta.endian || "little";
      this.platform = meta.platform || null;
      this.abi = meta.abi || null;
      this.imageBase = bigintOrNull(meta.imageBase) ?? 0n;
      this.entrypoint = bigintOrNull(meta.entrypoint);
      this.fileOffset = bigintOrNull(meta.fileOffset) ?? 0n;
      this.fileSize = bigintOrNull(meta.fileSize) ?? (this.bytes ? BigInt(this.bytes.length) : this.source?.size ?? 0n);
      this.segments = [];
      this.sections = [];
      this.imports = [];
      this.exports = [];
      this.symbols = [];
      this.relocations = [];
      this.functions = [];
      this.libraries = [];
      this.warnings = [];
      this.metadata = meta.metadata || {};
    }
    addSegment(s) {
      const seg = {
        name: s.name || "",
        address: BigInt(s.address ?? 0),
        size: BigInt(s.size ?? 0),
        fileOffset: BigInt(s.fileOffset ?? 0),
        fileSize: BigInt(s.fileSize ?? 0),
        perms: normalizePerms(s.perms),
        flags: s.flags ?? 0,
        source: s.source || this.format
      };
      this.segments.push(seg);
      return seg;
    }
    addSection(s) {
      const sec = {
        name: s.name || "",
        segment: s.segment || null,
        address: BigInt(s.address ?? 0),
        size: BigInt(s.size ?? 0),
        fileOffset: BigInt(s.fileOffset ?? 0),
        fileSize: BigInt(s.fileSize ?? s.size ?? 0),
        perms: normalizePerms(s.perms),
        flags: s.flags ?? 0,
        type: s.type ?? null,
        index: s.index ?? null,
        source: s.source || this.format
      };
      this.sections.push(sec);
      return sec;
    }
    addressToOffset(address) {
      const a = BigInt(address);
      for (const s of this.segments) {
        if (!inRange(a, s.address, s.fileSize)) continue;
        return s.fileOffset + (a - s.address);
      }
      for (const s of this.sections) {
        if (s.address === 0n || !inRange(a, s.address, s.fileSize)) continue;
        return s.fileOffset + (a - s.address);
      }
      return null;
    }
    offsetToAddress(offset) {
      const o = BigInt(offset);
      for (const s of this.segments) {
        if (!inRange(o, s.fileOffset, s.fileSize)) continue;
        return s.address + (o - s.fileOffset);
      }
      for (const s of this.sections) {
        if (s.address === 0n || !inRange(o, s.fileOffset, s.fileSize)) continue;
        return s.address + (o - s.fileOffset);
      }
      return null;
    }
    sectionAt(address) {
      const a = BigInt(address);
      return this.sections.find((s) => inRange(a, s.address, s.size)) || null;
    }
    segmentAt(address) {
      const a = BigInt(address);
      return this.segments.find((s) => inRange(a, s.address, s.size)) || null;
    }
    readVirtual(address, size) {
      if (!this.bytes) return null;
      const off = this.addressToOffset(address);
      if (off == null) return null;
      const o = Number(off);
      const n = Number(size);
      if (!Number.isSafeInteger(o) || !Number.isSafeInteger(n) || o < 0 || n < 0 || o > this.bytes.length || n > this.bytes.length - o) return null;
      return this.bytes.subarray(o, o + n);
    }
    async readVirtualAsync(address, size) {
      const resident = this.readVirtual(address, size);
      if (resident) return resident;
      if (!this.source) return null;
      const off = this.addressToOffset(address);
      if (off == null) return null;
      const n = typeof size === "bigint" ? size : BigInt(size);
      if (n < 0n || off < 0n || off > this.fileSize || n > this.fileSize - off) return null;
      return this.source.readExactly(off, n);
    }
    attachSource(source2, { discardBytes = false } = {}) {
      this.source = source2;
      this.fileSize = source2.size;
      if (discardBytes) this.bytes = null;
      return this;
    }
    finalize() {
      const byAddr = (a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
      this.segments.sort(byAddr);
      this.sections.sort(byAddr);
      this.symbols.sort(byAddr);
      this.exports.sort(byAddr);
      this.relocations.sort(byAddr);
      this.functions = mergeFunctionSeeds(this.functions, { sections: this.sections, segments: this.segments });
      this.imports = dedupeImports(this.imports);
      this.libraries = [...new Set(this.libraries.filter(Boolean))];
      return this;
    }
    summary() {
      return {
        format: this.format,
        arch: this.arch,
        bits: this.bits,
        endian: this.endian,
        platform: this.platform,
        imageBase: this.imageBase,
        entrypoint: this.entrypoint,
        segments: this.segments.length,
        sections: this.sections.length,
        imports: this.imports.length,
        exports: this.exports.length,
        symbols: this.symbols.length,
        relocations: this.relocations.length,
        functions: this.functions.length,
        libraries: this.libraries.length,
        warnings: [...this.warnings]
      };
    }
    toJSON() {
      const convert = (v) => {
        if (typeof v === "bigint") return v < 0n ? "-0x" + (-v).toString(16).toUpperCase() : "0x" + v.toString(16).toUpperCase();
        if (Array.isArray(v)) return v.map(convert);
        if (v && typeof v === "object") {
          const out = {};
          for (const [k, x] of Object.entries(v)) out[k] = convert(x);
          return out;
        }
        return v;
      };
      return convert({
        ...this.summary(),
        libraries: this.libraries,
        segments: this.segments,
        sections: this.sections,
        imports: this.imports,
        exports: this.exports,
        symbols: this.symbols,
        relocations: this.relocations,
        functions: this.functions,
        metadata: this.metadata
      });
    }
  };
  function functionSeed(address, opts = {}) {
    const source2 = opts.source || "heuristic";
    const confidence = Math.max(0, Math.min(1, Number(opts.confidence ?? 0.5)));
    const size = opts.size == null ? null : BigInt(opts.size);
    const end = opts.end == null ? null : BigInt(opts.end);
    const hasExtent = size != null || end != null;
    return {
      address: BigInt(address),
      size,
      end,
      name: opts.name || null,
      source: source2,
      confidence,
      kind: opts.kind || "function",
      exactFunctionStart: opts.exactFunctionStart === true,
      functionStartEvidence: opts.functionStartEvidence || null,
      extentSource: opts.extentSource || (hasExtent ? source2 : null),
      extentConfidence: opts.extentConfidence == null ? hasExtent ? confidence : null : Math.max(0, Math.min(1, Number(opts.extentConfidence))),
      extentInherited: !!opts.extentInherited
    };
  }
  function mergeFunctionSeeds(input, context = {}) {
    const rank = { symbol: 5, exception: 4, unwind: 4, function_starts: 4, export: 3, entrypoint: 2, heuristic: 1 };
    const m = /* @__PURE__ */ new Map();
    for (const f0 of input || []) {
      if (f0 == null || f0.address == null) continue;
      const f = { ...f0, address: BigInt(f0.address) };
      if ((f.size != null || f.end != null) && !f.extentSource) f.extentSource = f.source || "unknown";
      if ((f.size != null || f.end != null) && f.extentConfidence == null) f.extentConfidence = Number(f.confidence ?? 0);
      const k = f.address.toString();
      const prev = m.get(k);
      if (!prev) {
        m.set(k, f);
        continue;
      }
      const prevRank = rank[prev.source] || 0;
      const curRank = rank[f.source] || 0;
      const best = curRank > prevRank || curRank === prevRank && (f.confidence || 0) > (prev.confidence || 0) ? f : prev;
      const other = best === f ? prev : f;
      if (!best.name && other.name) best.name = other.name;
      best.exactFunctionStart = !!(prev.exactFunctionStart || f.exactFunctionStart);
      if (!best.functionStartEvidence) best.functionStartEvidence = other.functionStartEvidence || null;
      let inheritedExtent = false;
      if (best.size == null && other.size != null) {
        best.size = other.size;
        inheritedExtent = true;
      }
      if (best.end == null && other.end != null) {
        best.end = other.end;
        inheritedExtent = true;
      }
      if (inheritedExtent) {
        best.extentSource = other.extentSource || other.source || "unknown";
        best.extentConfidence = Number(other.extentConfidence ?? other.confidence ?? 0);
        best.extentInherited = true;
      } else if ((best.size != null || best.end != null) && !best.extentSource) {
        best.extentSource = best.source || "unknown";
        best.extentConfidence = Number(best.confidence ?? 0);
      }
      best.sources = [.../* @__PURE__ */ new Set([...prev.sources || [prev.source], ...f.sources || [f.source]])];
      best.confidence = Math.max(prev.confidence || 0, f.confidence || 0);
      m.set(k, best);
    }
    const out = [...m.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
    const regions2 = [...context.sections || [], ...context.segments || []].filter((r) => r && r.address != null && r.size != null && BigInt(r.size) > 0n && r.perms?.execute).sort((a, b) => BigInt(a.size) < BigInt(b.size) ? -1 : BigInt(a.size) > BigInt(b.size) ? 1 : 0);
    const regionFor = (addr) => regions2.find((r) => BigInt(addr) >= BigInt(r.address) && BigInt(addr) < BigInt(r.address) + BigInt(r.size)) || null;
    for (let i = 0; i < out.length; i++) {
      const f = out[i];
      if (f.end == null && f.size != null) f.end = f.address + f.size;
      if (f.size == null && f.end != null && f.end > f.address) f.size = f.end - f.address;
      if (f.size == null && i + 1 < out.length && out[i + 1].address > f.address) {
        const next = out[i + 1];
        const sources = new Set(f.sources || [f.source]);
        const nextSources = new Set(next.sources || [next.source]);
        const provenFunctionStarts = sources.has("function_starts") && nextSources.has("function_starts");
        const delta = next.address - f.address;
        const currentRegion = regionFor(f.address), nextRegion = regionFor(next.address);
        const sameCanonicalRegion = !regions2.length || currentRegion != null && currentRegion === nextRegion;
        const withinRegionEnd = !currentRegion || next.address <= BigInt(currentRegion.address) + BigInt(currentRegion.size);
        if (provenFunctionStarts && sameCanonicalRegion && withinRegionEnd && delta <= 0x1000000n) {
          f.size = delta;
          f.end = next.address;
          f.extentInferred = true;
          f.extentConfidence = Math.min(0.35, Number(f.confidence ?? 0.35));
          f.extentSource = "next-function-start";
        }
      }
    }
    return out;
  }
  function dedupeImports(input) {
    const m = /* @__PURE__ */ new Map();
    for (const i of input || []) {
      const scalar = (value) => typeof value === "bigint" ? value.toString() : value == null ? "" : String(value);
      const key = [i.library || "", i.name || "", scalar(i.ordinal), i.weak ? "1" : "0", scalar(i.addend ?? 0n), scalar(i.pointerFormat), scalar(i.type), scalar(i.version), i.versionLibrary || ""].join("\0");
      const prev = m.get(key);
      if (!prev) {
        m.set(key, { ...i, sites: i.sites ? [...i.sites] : [] });
        continue;
      }
      if (!prev.address && i.address) prev.address = i.address;
      if (!prev.source && i.source) prev.source = i.source;
      if (i.sites) prev.sites.push(...i.sites);
    }
    for (const i of m.values()) {
      if (i.sites) {
        const seen = /* @__PURE__ */ new Set();
        i.sites = i.sites.filter((s) => {
          const scalar = (value) => typeof value === "bigint" ? value.toString() : value == null ? "" : String(value);
          const key = [scalar(s.address), scalar(s.offset), s.kind || "", scalar(s.type), scalar(s.addend), scalar(s.pointerFormat), s.weak ? "1" : "0"].join(":");
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    }
    return [...m.values()];
  }

  // js/binary/macho-budget.js
  var MACHO_METADATA_LIMITS = Object.freeze({
    inputBytes: 64 * 1024 * 1024,
    records: 25e4,
    objects: 5e5,
    stringBytes: 16 * 1024 * 1024,
    operations: 2e6,
    warnings: 2048,
    estimatedHeapBytes: 128 * 1024 * 1024,
    wallClockMs: 5e3
  });
  function metadataOf(image2) {
    image2.metadata ||= {};
    return image2.metadata.machoMetadata ||= { complete: true, reasons: [] };
  }
  function markMachOMetadataPartial(image2, reason) {
    const meta = metadataOf(image2);
    meta.complete = false;
    if (!meta.reasons.includes(reason)) meta.reasons.push(reason);
  }
  function createMachOMetadataBudget(image2, options = {}) {
    const limits = { ...MACHO_METADATA_LIMITS, ...options.limits || options.metadataLimits || {} };
    const signal = options.signal || null;
    const started = Date.now();
    const used = {
      inputBytes: 0,
      records: 0,
      objects: 0,
      stringBytes: 0,
      operations: 0,
      warnings: Math.min(image2.warnings?.length || 0, limits.warnings),
      estimatedHeapBytes: 0
    };
    const meta = metadataOf(image2);
    meta.limits = { ...limits };
    meta.used = used;
    let nextTimeCheck = 1024;
    const stop = (reason) => {
      markMachOMetadataPartial(image2, `budget:${reason}`);
      return false;
    };
    return {
      limits,
      used,
      signal,
      get remainingStringBytes() {
        return Math.max(0, limits.stringBytes - used.stringBytes);
      },
      remaining(key) {
        return Math.max(0, Number(limits[key] ?? 0) - Number(used[key] ?? 0));
      },
      take(cost = {}, reason = "metadata") {
        if (signal?.aborted) return stop("aborted");
        const opCost = Math.max(0, Number(cost.operations || 0));
        if (used.operations + opCost >= nextTimeCheck) {
          nextTimeCheck = used.operations + opCost + 1024;
          if (Date.now() - started > limits.wallClockMs) return stop("wall-clock");
        }
        for (const key of Object.keys(used)) {
          const next = used[key] + Math.max(0, Number(cost[key] || 0));
          if (!Number.isFinite(next) || next > limits[key]) return stop(`${reason}:${key}`);
        }
        for (const key of Object.keys(used)) used[key] += Math.max(0, Number(cost[key] || 0));
        return true;
      },
      partial(reason, warning = null) {
        markMachOMetadataPartial(image2, reason);
        if (warning) this.warn(warning);
        return false;
      },
      warn(message) {
        const text = String(message);
        if (image2.warnings?.includes(text)) return true;
        if (!this.take({ warnings: 1, objects: 1, stringBytes: text.length * 2, estimatedHeapBytes: text.length * 2 + 32 }, "warning")) return false;
        image2.warnings.push(text);
        return true;
      },
      snapshot() {
        const current2 = metadataOf(image2);
        return { complete: current2.complete, reasons: [...current2.reasons], limits: { ...limits }, used: { ...used } };
      }
    };
  }
  function ensureMachOMetadataBudget(image2, budget = null) {
    if (budget) return budget;
    if (image2.__machoMetadataBudget) return image2.__machoMetadataBudget;
    const created = createMachOMetadataBudget(image2);
    Object.defineProperty(image2, "__machoMetadataBudget", { value: created, configurable: true, enumerable: false, writable: false });
    return created;
  }

  // js/binary/macho-dyld.js
  function parseChainedImports(r, dc, image2, sharedBudget = null) {
    const budget = ensureMachOMetadataBudget(image2, sharedBudget);
    if (!dc.size || dc.offset + dc.size > r.length || dc.size < 28) return null;
    const base = dc.offset;
    const version = r.u32(base);
    const startsOffset = r.u32(base + 4);
    const importsOffset = r.u32(base + 8);
    const symbolsOffset = r.u32(base + 12);
    const importsCount = r.u32(base + 16);
    const importsFormat = r.u32(base + 20);
    const symbolsFormat = r.u32(base + 24);
    image2.metadata.chainedFixups = { version, startsOffset, importsCount, importsFormat, symbolsFormat, complete: true, symbolsComplete: true };
    if (symbolsFormat !== 0) {
      image2.metadata.chainedFixups.complete = false;
      image2.metadata.chainedFixups.symbolsComplete = false;
      image2.metadata.chainedFixups.partialReason = symbolsFormat === 1 ? "compressed-symbol-pool" : "unknown-symbol-pool-format";
      image2.warnings.push(`chained-fixups symbol pool format ${symbolsFormat} is not supported; results are partial`);
      return null;
    }
    const importsBase = base + importsOffset;
    const stringsBase = base + symbolsOffset;
    const entrySize = importsFormat === 1 ? 4 : importsFormat === 2 ? 8 : importsFormat === 3 ? 16 : 0;
    if (!entrySize) {
      image2.warnings.push(`unknown chained import format ${importsFormat}`);
      return null;
    }
    if (importsBase + importsCount * entrySize > base + dc.size) {
      image2.warnings.push("chained imports are truncated");
      return null;
    }
    const parsed = [];
    for (let i = 0; i < importsCount; i++) {
      if (!budget.take({ inputBytes: entrySize, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 224 }, "chained-import-record")) {
        image2.metadata.chainedFixups.importsComplete = false;
        image2.metadata.chainedFixups.importsPartialReason = "metadata-budget";
        break;
      }
      const p = importsBase + i * entrySize;
      let ordinal, weak, nameOffset, addend = 0n;
      if (importsFormat === 1 || importsFormat === 2) {
        const raw = r.u32(p);
        ordinal = signExtend(raw & 255, 8);
        weak = !!(raw >>> 8 & 1);
        nameOffset = raw >>> 9;
        if (importsFormat === 2) addend = BigInt(r.i32(p + 4));
      } else {
        const raw = r.u32(p);
        ordinal = signExtend(raw & 65535, 16);
        weak = !!(raw >>> 16 & 1);
        nameOffset = r.u32(p + 4);
        addend = r.i64(p + 8);
      }
      const strp = stringsBase + nameOffset;
      if (strp < base || strp >= base + dc.size) continue;
      const name = r.cstring(strp, base + dc.size - strp);
      if (!name) continue;
      if (!budget.take({ stringBytes: name.length * 2, estimatedHeapBytes: name.length * 2 + 32 }, "chained-import-name")) break;
      const imp = { name, library: dylibForOrdinal(image2, ordinal), ordinal, weak, addend, source: "chained-fixups", sites: [], chainedIndex: i };
      image2.imports.push(imp);
      parsed[i] = imp;
    }
    return parsed;
  }
  function parseChainedBindingSites(r, dc, image2, imports, segments = image2.segments || [], sharedBudget = null) {
    const budget = ensureMachOMetadataBudget(image2, sharedBudget);
    const base = dc.offset;
    const payloadEnd = base + dc.size;
    image2.metadata.chainedFixups ||= {};
    const status = image2.metadata.chainedFixups;
    status.bindingSitesComplete = status.bindingSitesComplete !== false;
    status.bindingSiteReasons ||= [];
    let decoded = 0;
    const fail = (message) => {
      status.complete = false;
      status.bindingSitesComplete = false;
      if (!status.bindingSiteReasons.includes(message)) status.bindingSiteReasons.push(message);
      const warning = `chained-fixups: ${message}`;
      if (!image2.warnings.includes(warning)) image2.warnings.push(warning);
    };
    const startsOffset = r.u32(base + 4);
    if (!startsOffset || base + startsOffset + 4 > payloadEnd) {
      fail("starts-in-image header is missing or truncated");
      status.bindingSites = decoded;
      return status;
    }
    const startsBase = base + startsOffset;
    const segCount = r.u32(startsBase);
    if (segCount > 4096 || startsBase + 4 + segCount * 4 > payloadEnd) {
      fail("segment starts table is truncated or unreasonable");
      status.bindingSites = decoded;
      return status;
    }
    if (segCount !== segments.length) fail(`segment count ${segCount} does not match Mach-O load-command segment count ${segments.length}`);
    const count = Math.min(segCount, segments.length);
    for (let segIndex = 0; segIndex < count; segIndex++) {
      const rel = r.u32(startsBase + 4 + segIndex * 4);
      if (!rel) continue;
      const seg = segments[segIndex];
      const p = startsBase + rel;
      if (!seg || p + 22 > payloadEnd) {
        fail(`segment ${segIndex} starts record is truncated`);
        continue;
      }
      const structSize = r.u32(p);
      const pageSize = r.u16(p + 4);
      const pointerFormat = r.u16(p + 6);
      const segmentOffset = r.u64(p + 8);
      const maxValidPointer = r.u32(p + 16);
      const pageCount = r.u16(p + 20);
      if (structSize < 22 || p + structSize > payloadEnd || 22 + pageCount * 2 > structSize) {
        fail(`segment ${segIndex} starts record size/page table is invalid`);
        continue;
      }
      if (pageSize !== 4096 && pageSize !== 16384) {
        fail(`segment ${segIndex} has invalid chained page size 0x${pageSize.toString(16)}`);
        continue;
      }
      const width = chainedPointerWidth(pointerFormat);
      if (!width) {
        markUnsupportedChainedFormat(image2, pointerFormat);
        fail(`segment ${segIndex} uses unsupported pointer format ${pointerFormat}`);
        continue;
      }
      const segAddress = BigInt(seg.address ?? 0);
      const segSize = BigInt(seg.size ?? 0);
      const segFileOffset = BigInt(seg.fileOffset ?? 0);
      const segFileSize = BigInt(seg.fileSize ?? seg.size ?? 0);
      if (segAddress < image2.imageBase || segmentOffset !== segAddress - image2.imageBase) {
        fail(`segment ${segIndex} segment_offset does not identify its Mach-O segment`);
        continue;
      }
      const pageSizeBig = BigInt(pageSize);
      const maxPages = segSize === 0n ? 0n : (segSize + pageSizeBig - 1n) / pageSizeBig;
      if (BigInt(pageCount) > maxPages) {
        fail(`segment ${segIndex} page_count exceeds segment VM range`);
        continue;
      }
      const structEnd = p + structSize;
      const overflowBase = p + 22 + pageCount * 2;
      if ((structEnd - overflowBase) % 2 !== 0) {
        fail(`segment ${segIndex} chain_starts array is misaligned`);
        continue;
      }
      const overflowCount = (structEnd - overflowBase) / 2;
      for (let page = 0; page < pageCount; page++) {
        if (!budget.take({ inputBytes: 2, records: 1, operations: 1, estimatedHeapBytes: 16 }, "chained-page")) {
          fail("shared metadata budget exhausted while decoding pages");
          status.bindingSites = decoded;
          return status;
        }
        const start = r.u16(p + 22 + page * 2);
        if (start === 65535) continue;
        const pageOffset = BigInt(page) * pageSizeBig;
        if (pageOffset >= segSize) {
          fail(`segment ${segIndex} page ${page} starts outside segment`);
          continue;
        }
        const pageVmEnd = pageOffset + pageSizeBig < segSize ? pageOffset + pageSizeBig : segSize;
        const pageFileEnd = pageVmEnd < segFileSize ? pageVmEnd : segFileSize;
        const starts = [];
        if (start & 32768) {
          let oi = start & 32767;
          if (oi >= overflowCount) {
            fail(`segment ${segIndex} page ${page} chain_starts index is out of range`);
            continue;
          }
          let terminated = false;
          for (let guard = 0; guard < 4096 && oi < overflowCount; guard++, oi++) {
            const x = r.u16(overflowBase + oi * 2);
            starts.push(x & 32767);
            if (x & 32768) {
              terminated = true;
              break;
            }
          }
          if (!terminated) {
            fail(`segment ${segIndex} page ${page} multi-start list is unterminated`);
            continue;
          }
        } else {
          starts.push(start);
        }
        const pageAddress = segAddress + pageOffset;
        const pageAddressEnd = segAddress + pageVmEnd;
        const fileBackedAddressEnd = segAddress + pageFileEnd;
        for (const chainStart of starts) {
          if (chainStart >= pageSize || BigInt(chainStart) + BigInt(width) > pageVmEnd - pageOffset || BigInt(chainStart) + BigInt(width) > pageFileEnd - pageOffset) {
            fail(`segment ${segIndex} page ${page} chain start 0x${chainStart.toString(16)} is outside file-backed page data`);
            continue;
          }
          let address = pageAddress + BigInt(chainStart);
          let terminated = false;
          for (let guard = 0; guard < 1e5; guard++) {
            if (!budget.take({ inputBytes: width, records: 1, operations: 1, estimatedHeapBytes: 16 }, "chained-pointer")) {
              fail("shared metadata budget exhausted while decoding pointer chain");
              status.bindingSites = decoded;
              return status;
            }
            if (address < pageAddress || address + BigInt(width) > pageAddressEnd || address + BigInt(width) > fileBackedAddressEnd) {
              fail(`segment ${segIndex} page ${page} chain leaves its page or file-backed segment range`);
              break;
            }
            const off = image2.addressToOffset(address);
            const expectedOff = segFileOffset + (address - segAddress);
            if (off == null || BigInt(off) !== expectedOff || expectedOff + BigInt(width) > segFileOffset + segFileSize || expectedOff + BigInt(width) > BigInt(r.length)) {
              fail(`segment ${segIndex} page ${page} chain address is not backed by its owning segment`);
              break;
            }
            const raw = width === 4 ? BigInt(r.u32(Number(expectedOff))) : r.u64(Number(expectedOff));
            const d = decodeChainedPointer(raw, pointerFormat);
            if (!d) {
              markUnsupportedChainedFormat(image2, pointerFormat);
              fail(`segment ${segIndex} pointer format ${pointerFormat} could not be decoded`);
              break;
            }
            if (d.bind && d.ordinal >= 0 && d.ordinal < imports.length && imports[d.ordinal]) {
              if (!budget.take({ objects: 1, operations: 1, estimatedHeapBytes: 112 }, "chained-bind-site")) {
                fail("shared metadata budget exhausted while recording bind site");
                status.bindingSites = decoded;
                return status;
              }
              imports[d.ordinal].sites.push({ address, offset: expectedOff, kind: "chained-bind", pointerFormat, addend: d.addend });
              decoded++;
            }
            if (!d.next) {
              terminated = true;
              break;
            }
            const delta = BigInt(d.next) * BigInt(d.stride);
            const nextAddress = address + delta;
            if (delta <= 0n || nextAddress <= address || nextAddress + BigInt(width) > pageAddressEnd || nextAddress + BigInt(width) > fileBackedAddressEnd) {
              fail(`segment ${segIndex} page ${page} chained next leaves its page`);
              break;
            }
            address = nextAddress;
          }
          if (!terminated && status.bindingSitesComplete && starts.length) fail(`segment ${segIndex} page ${page} chain exceeded iteration budget`);
        }
      }
      void maxValidPointer;
    }
    status.bindingSites = decoded;
    return status;
  }
  function chainedPointerWidth(format) {
    if ([3, 4, 5].includes(format)) return 4;
    if ([1, 2, 6, 7, 9, 10, 12].includes(format)) return 8;
    return 0;
  }
  function markUnsupportedChainedFormat(image2, format) {
    image2.metadata.chainedFixups ||= {};
    image2.metadata.chainedFixups.complete = false;
    image2.metadata.chainedFixups.bindingSitesComplete = false;
    const list = image2.metadata.chainedFixups.unsupportedPointerFormats ||= [];
    if (!list.includes(format)) {
      list.push(format);
      image2.warnings.push(`chained pointer format ${format} is not supported; binding sites are partial`);
    }
  }
  function decodeChainedPointer(raw, format) {
    if (format === 3) {
      const bind = !!(raw >> 31n & 1n);
      const next = Number(raw >> 26n & 0x1fn);
      if (!bind) return { bind: false, ordinal: -1, addend: 0n, next, stride: 4 };
      const ordinal = Number(raw & 0xfffffn);
      let addend = Number(raw >> 20n & 0x3fn);
      if (addend & 32) addend -= 64;
      return { bind: true, ordinal, addend: BigInt(addend), next, stride: 4 };
    }
    if (format === 2 || format === 6) {
      const bind = !!(raw >> 63n);
      const next = Number(raw >> 51n & 0xfffn);
      if (!bind) return { bind: false, ordinal: -1, addend: 0n, next, stride: 4 };
      const ordinal = Number(raw & 0xffffffn);
      let addend = Number(raw >> 24n & 0xffn);
      if (addend & 128) addend -= 256;
      return { bind: true, ordinal, addend: BigInt(addend), next, stride: 4 };
    }
    if ([1, 7, 9, 10, 12].includes(format)) {
      const bind = !!(raw >> 62n & 1n);
      const next = Number(raw >> 51n & 0x7ffn);
      const ordinalBits = format === 12 ? 24n : 16n;
      const ordinalMask = (1n << ordinalBits) - 1n;
      const ordinal = Number(raw & ordinalMask);
      const auth = !!(raw >> 63n & 1n);
      let addend = 0n;
      if (bind && !auth) {
        let a = Number(raw >> 32n & 0x7ffffn);
        if (a & 262144) a -= 524288;
        addend = BigInt(a);
      }
      const stride = format === 7 || format === 10 ? 4 : 8;
      return { bind, ordinal, addend, next, stride };
    }
    return null;
  }
  function parseClassicBindings(r, dc, image2, segments, source2, sharedBudget = null) {
    const budget = ensureMachOMetadataBudget(image2, sharedBudget);
    if (!dc || !dc.size || dc.offset + dc.size > r.length) return null;
    const BIND_OPCODE_MASK = 240, BIND_IMMEDIATE_MASK = 15;
    const ptrSize = image2.bits === 64 ? 8n : 4n;
    let p = dc.offset;
    const end = dc.offset + dc.size;
    let libOrdinal = 0, symbol = "", symbolFlags = 0, type = 1, addend = 0n, segIndex = 0, segOffset = 0n;
    let threadedTable = null, threadedTableLimit = 0;
    const status = { source: source2, complete: true, decodedBinds: 0, threadedApplies: 0, unsupportedOpcodes: [] };
    image2.metadata.dyldBindings ||= { complete: true, streams: {} };
    image2.metadata.dyldBindings.streams[source2] = status;
    const fail = (message, opcode = null) => {
      status.complete = false;
      image2.metadata.dyldBindings.complete = false;
      if (opcode != null && !status.unsupportedOpcodes.includes(opcode)) status.unsupportedOpcodes.push(opcode);
      image2.warnings.push(`${source2}: ${message}`);
    };
    const snapshotImport = () => ({ name: symbol, library: dylibForOrdinal(image2, libOrdinal), ordinal: libOrdinal, weak: !!(symbolFlags & 1), symbolFlags, nonWeakDefinition: !!(symbolFlags & 8), addend, type, source: source2, sites: [] });
    const validLocation = () => {
      const seg = segments[segIndex];
      return !!seg && segOffset >= 0n && segOffset <= seg.size && ptrSize <= seg.size - segOffset;
    };
    const bind = () => {
      if (!symbol) return;
      if (threadedTable && threadedTable.length < threadedTableLimit) {
        threadedTable.push(snapshotImport());
        return;
      }
      if (!validLocation()) {
        fail(`bind location is outside segment ${segIndex} at +0x${segOffset.toString(16)}`);
        return;
      }
      const seg = segments[segIndex];
      const address = seg.address + segOffset;
      const imp = snapshotImport();
      imp.sites.push({ address, offset: image2.addressToOffset(address), kind: source2, type, addend, weak: imp.weak });
      if (!budget.take({ objects: 2, operations: 1, estimatedHeapBytes: 320 }, "classic-bind-output")) {
        fail("shared metadata budget exhausted while recording bind");
        return;
      }
      image2.imports.push(imp);
      status.decodedBinds++;
    };
    const applyThreaded = () => {
      if (!threadedTable) {
        fail("threaded APPLY encountered before ordinal table");
        return;
      }
      if (!validLocation()) {
        fail("threaded APPLY starts outside its segment");
        return;
      }
      const seg = segments[segIndex];
      let address = seg.address + segOffset;
      for (let guard = 0; guard < 1e5; guard++) {
        const off = image2.addressToOffset(address);
        if (off == null || off + 8n > BigInt(r.length)) {
          fail("threaded binding chain leaves mapped file data");
          return;
        }
        const raw = r.u64(Number(off));
        const isBind = !!(raw >> 62n & 1n);
        const delta = Number(raw >> 51n & 0x7ffn);
        if (isBind) {
          const ordinal = Number(raw & 0xffffn);
          const template = threadedTable[ordinal];
          if (!template) fail(`threaded bind ordinal ${ordinal} is outside table`);
          else {
            const imp = { ...template, sites: [{ address, offset: off, kind: "threaded-bind", type: template.type, addend: template.addend, weak: template.weak }] };
            if (!budget.take({ objects: 2, operations: 1, estimatedHeapBytes: 320 }, "classic-bind-output")) {
              fail("shared metadata budget exhausted while recording bind");
              return;
            }
            image2.imports.push(imp);
            status.decodedBinds++;
          }
        }
        if (!delta) {
          status.threadedApplies++;
          return;
        }
        address += BigInt(delta * 8);
        if (address < seg.address || address + ptrSize > seg.address + seg.size) {
          fail("threaded binding delta leaves segment");
          return;
        }
      }
      fail("threaded binding chain exceeded the 100000-entry budget");
    };
    try {
      while (p < end) {
        if (!budget.take({ inputBytes: 1, records: 1, operations: 1, estimatedHeapBytes: 8 }, "classic-bind-opcode")) {
          fail("shared metadata budget exhausted while decoding bind stream");
          break;
        }
        const byte = r.u8(p++);
        const op = byte & BIND_OPCODE_MASK;
        const imm = byte & BIND_IMMEDIATE_MASK;
        if (op === 0) {
          if (source2 === "lazy-bind") {
            symbol = "";
            symbolFlags = 0;
            libOrdinal = 0;
            addend = 0n;
            continue;
          }
          break;
        } else if (op === 16) libOrdinal = imm;
        else if (op === 32) {
          const x = r.uleb(p, 10, end);
          p = x.next;
          libOrdinal = Number(x.value);
        } else if (op === 48) libOrdinal = imm === 0 ? 0 : signExtend(imm | 240, 8);
        else if (op === 64) {
          const x = rawCString(r, p, end);
          symbol = x.text;
          symbolFlags = imm;
          p = x.next;
        } else if (op === 80) type = imm;
        else if (op === 96) {
          const x = r.sleb(p, 10, end);
          p = x.next;
          addend = x.value;
        } else if (op === 112) {
          segIndex = imm;
          const x = r.uleb(p, 10, end);
          p = x.next;
          segOffset = x.value;
        } else if (op === 128) {
          const x = r.uleb(p, 10, end);
          p = x.next;
          segOffset += x.value;
        } else if (op === 144) {
          bind();
          segOffset += ptrSize;
        } else if (op === 160) {
          bind();
          const x = r.uleb(p, 10, end);
          p = x.next;
          segOffset += ptrSize + x.value;
        } else if (op === 176) {
          bind();
          segOffset += ptrSize + BigInt(imm) * ptrSize;
        } else if (op === 192) {
          const a = r.uleb(p, 10, end);
          p = a.next;
          const b = r.uleb(p, 10, end);
          p = b.next;
          if (a.value > BigInt(Number.MAX_SAFE_INTEGER)) {
            fail("bind repeat count exceeds safe integer range");
            break;
          }
          const repeat = Number(a.value), step = ptrSize + b.value, owner = segments[segIndex];
          const maxBySegment = owner && step > 0n && segOffset >= 0n && segOffset + ptrSize <= owner.size ? Number((owner.size - segOffset - ptrSize) / step + 1n) : 0;
          const maxByBudget = Math.min(budget.remaining("operations"), Math.floor(budget.remaining("objects") / 2));
          const allowed = Math.max(0, Math.min(repeat, maxBySegment, maxByBudget));
          for (let i = 0; i < allowed; i++) {
            bind();
            segOffset += step;
          }
          if (allowed < repeat) {
            fail(`bind repeat count ${repeat} exceeds segment/shared metadata capacity ${allowed}`);
            break;
          }
        } else if (op === 208) {
          if (imm === 0) {
            const x = r.uleb(p, 10, end);
            p = x.next;
            if (x.value > 65536n) {
              fail("threaded ordinal table exceeds 65536 entries");
              break;
            }
            threadedTableLimit = Number(x.value);
            threadedTable = [];
          } else if (imm === 1) applyThreaded();
          else {
            fail(`unknown threaded bind subopcode 0x${imm.toString(16)}`, byte);
            break;
          }
        } else {
          fail(`unknown dyld bind opcode 0x${op.toString(16)}`, byte);
          break;
        }
      }
    } catch (e) {
      if (e?.code === "BINARY_SOURCE_RANGE_MISSING") throw e;
      fail(`bounded stream operand is truncated: ${e.message}`);
    }
    if (threadedTable && threadedTable.length !== threadedTableLimit) fail(`threaded ordinal table expected ${threadedTableLimit} entries, decoded ${threadedTable.length}`);
    return status;
  }
  function parseExportTrie(r, dc, image2, sharedBudget = null) {
    const budget = ensureMachOMetadataBudget(image2, sharedBudget);
    if (!dc || !dc.size || dc.offset + dc.size > r.length) return null;
    const base = dc.offset, end = dc.offset + dc.size;
    const active2 = /* @__PURE__ */ new Set();
    const status = { complete: true, nodes: 0, edges: 0, cycleDetected: false, budgetExceeded: false };
    image2.metadata.exportTrie = status;
    const markPartial = (message, field) => {
      status.complete = false;
      if (field) status[field] = true;
      image2.warnings.push(`exports trie: ${message}`);
    };
    const walk = (nodeOff, prefix, depth) => {
      if (depth > 256) {
        markPartial("depth budget exceeded", "budgetExceeded");
        return;
      }
      if (!Number.isSafeInteger(nodeOff) || nodeOff < 0 || base + nodeOff >= end) {
        markPartial("child node offset is outside trie");
        return;
      }
      if (active2.has(nodeOff)) {
        markPartial(`cycle detected at node 0x${nodeOff.toString(16)}`, "cycleDetected");
        return;
      }
      if (!budget.take({ records: 1, objects: 1, operations: 1, estimatedHeapBytes: 48 }, "export-trie-node")) {
        markPartial("shared metadata node budget exceeded", "budgetExceeded");
        return;
      }
      status.nodes++;
      active2.add(nodeOff);
      try {
        let p = base + nodeOff;
        const term = r.uleb(p, 10, end);
        p = term.next;
        const terminalSize = Number(term.value);
        if (!Number.isSafeInteger(terminalSize) || terminalSize < 0 || p + terminalSize > end) {
          markPartial("terminal payload is truncated");
          return;
        }
        const terminalEnd = p + terminalSize;
        if (term.value) {
          const flagsX = r.uleb(p, 10, terminalEnd);
          p = flagsX.next;
          const flags = Number(flagsX.value);
          if (flags & 8) {
            const ord = r.uleb(p, 10, terminalEnd);
            p = ord.next;
            const importedX = rawCString(r, p, terminalEnd);
            image2.exports.push({ name: prefix, address: 0n, kind: "reexport", flags, ordinal: Number(ord.value), imported: importedX.text || null, source: "exports-trie" });
          } else {
            const addrX = r.uleb(p, 10, terminalEnd);
            p = addrX.next;
            const exportKind = flags & 3;
            const address = exportKind === 0 ? image2.imageBase + addrX.value : addrX.value;
            const kind = exportKind === 1 ? "thread-local" : exportKind === 2 ? "absolute" : "export";
            const ex = { name: prefix, address, kind, flags, source: "exports-trie" };
            if (flags & 16) {
              const resolverX = r.uleb(p, 10, terminalEnd);
              p = resolverX.next;
              ex.resolver = image2.imageBase + resolverX.value;
            }
            if (!budget.take({ objects: 1, operations: 1, stringBytes: prefix.length * 2, estimatedHeapBytes: prefix.length * 2 + 160 }, "export-trie-output")) {
              markPartial("shared metadata output budget exceeded", "budgetExceeded");
              return;
            }
            image2.exports.push(ex);
            if (exportKind === 0) {
              const sec = image2.sectionAt(address);
              if (sec && sec.perms.execute) {
                if (!budget.take({ objects: 1, operations: 1, estimatedHeapBytes: 128 }, "export-function")) {
                  markPartial("shared metadata function budget exceeded", "budgetExceeded");
                  return;
                }
              }
              image2.functions.push(functionSeed(address, { name: prefix, source: "export", confidence: 0.9 }));
            }
          }
        }
        p = terminalEnd;
        if (p >= end) return;
        const children = r.u8(p++);
        for (let i = 0; i < children; i++) {
          if (!budget.take({ records: 1, operations: 1, estimatedHeapBytes: 32 }, "export-trie-edge")) {
            markPartial("shared metadata edge budget exceeded", "budgetExceeded");
            return;
          }
          status.edges++;
          const edgeX = rawCString(r, p, end);
          const edge = edgeX.text;
          p = edgeX.next;
          if (p >= end) {
            markPartial("child offset is truncated");
            return;
          }
          const child = r.uleb(p, 10, end);
          p = child.next;
          walk(Number(child.value), prefix + edge, depth + 1);
        }
      } finally {
        active2.delete(nodeOff);
      }
    };
    try {
      walk(0, "", 0);
    } catch (e) {
      if (e?.code === "BINARY_SOURCE_RANGE_MISSING") throw e;
      markPartial(e.message);
    }
    return status;
  }
  function rawCString(r, p, end) {
    const start = p;
    while (p < end && r.u8(p) !== 0) p++;
    if (p >= end) throw new Error("unterminated C string");
    const raw = r.slice(start, p - start);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    } catch {
      text = Array.from(raw, (c) => c >= 32 && c <= 126 ? String.fromCharCode(c) : "�").join("");
    }
    return { text, next: p + 1, bytes: p + 1 - start };
  }
  function dylibForOrdinal(image2, ordinal) {
    if (ordinal === 0) return null;
    if (ordinal === -1 || ordinal === 255) return "<main-executable>";
    if (ordinal === -2 || ordinal === 254) return "<flat-lookup>";
    if (ordinal === -3 || ordinal === 253) return "<weak-lookup>";
    return ordinal > 0 ? image2.libraries[ordinal - 1] || null : null;
  }
  function signExtend(v, bits) {
    const sign = 1 << bits - 1;
    const mask = (1 << bits) - 1;
    v &= mask;
    return v & sign ? v - (1 << bits) : v;
  }

  // js/binary/macho.js
  var LC_SEGMENT = 1;
  var LC_SYMTAB = 2;
  var LC_THREAD = 4;
  var LC_UNIXTHREAD = 5;
  var LC_LOAD_DYLIB = 12;
  var LC_ID_DYLIB = 13;
  var LC_LOAD_WEAK_DYLIB = 2147483672;
  var LC_REEXPORT_DYLIB = 2147483679;
  var LC_LAZY_LOAD_DYLIB = 32;
  var LC_LOAD_UPWARD_DYLIB = 2147483683;
  var LC_SEGMENT_64 = 25;
  var LC_DYLD_INFO = 34;
  var LC_DYLD_INFO_ONLY = 2147483682;
  var LC_FUNCTION_STARTS = 38;
  var LC_VERSION_MIN_MACOSX = 36;
  var LC_VERSION_MIN_IPHONEOS = 37;
  var LC_MAIN = 2147483688;
  var LC_VERSION_MIN_TVOS = 47;
  var LC_VERSION_MIN_WATCHOS = 48;
  var LC_BUILD_VERSION = 50;
  var LC_DYLD_EXPORTS_TRIE = 2147483699;
  var LC_DYLD_CHAINED_FIXUPS = 2147483700;
  var DYLIB_COMMANDS = /* @__PURE__ */ new Set([
    LC_LOAD_DYLIB,
    LC_LOAD_WEAK_DYLIB,
    LC_REEXPORT_DYLIB,
    LC_LAZY_LOAD_DYLIB,
    LC_LOAD_UPWARD_DYLIB
  ]);
  function parseMachO(input, opts = {}) {
    const bytes = new ByteView(input).bytes;
    const kind = machoKind(bytes);
    if (!kind) throw new Error("not a Mach-O file");
    if (kind.fat) {
      const selected = selectFatSlice(bytes, kind, opts.arch);
      if (!selected) throw new Error("Mach-O universal binary has no readable slice");
      const sub = bytes.subarray(Number(selected.offset), Number(selected.offset + selected.size));
      const image2 = parseThin(sub, { ...opts, containerOffset: selected.offset });
      image2.metadata.fat = {
        slices: selected.all.map((s) => ({ arch: sliceArchName(s), cpu: s.cpu, subtype: s.subtype, offset: s.offset, size: s.size })),
        selected: { arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size }
      };
      return image2;
    }
    return parseThin(bytes, opts);
  }
  function parseThin(bytes, opts) {
    const kind = machoKind(bytes);
    if (!kind || kind.fat) throw new Error("not a thin Mach-O file");
    const r = new ByteView(bytes, { littleEndian: kind.littleEndian });
    const bits = kind.bits;
    const headerSize = bits === 64 ? 32 : 28;
    const cpu = r.i32(4);
    const subtype = r.i32(8);
    const filetype = r.u32(12);
    const ncmds = r.u32(16);
    const sizeofcmds = r.u32(20);
    const flags = r.u32(24);
    if (headerSize + sizeofcmds > r.length) throw new Error("Mach-O load commands exceed file");
    const commandEnd = headerSize + sizeofcmds;
    const arch = cpuArchName(cpu, subtype);
    const image2 = new BinaryImage(bytes, {
      format: "macho",
      arch,
      bits,
      endian: kind.littleEndian ? "little" : "big",
      platform: "apple",
      imageBase: 0n,
      fileOffset: opts.containerOffset || 0n,
      metadata: {
        cpu,
        subtype,
        cpuName: cpuName(cpu),
        subtypeBase: subtypeBase(subtype),
        subtypeName: arch === "arm64e" ? "arm64e" : String(subtypeBase(subtype)),
        filetype,
        flags,
        ncmds,
        sizeofcmds
      }
    });
    const metadataBudget = ensureMachOMetadataBudget(image2, createMachOMetadataBudget(image2, { signal: opts.signal }));
    const commands = [];
    const segmentOrder = [];
    const symtabs = [];
    const linkeditData = {};
    const dyldInfos = [];
    let p = headerSize;
    for (let i = 0; i < ncmds; i++) {
      if (p + 8 > commandEnd) {
        image2.warnings.push(`truncated load command ${i}`);
        break;
      }
      const cmd = r.u32(p);
      const cmdsize = r.u32(p + 4);
      if (cmdsize < 8 || p + cmdsize > commandEnd) {
        image2.warnings.push(`invalid load command ${i} size ${cmdsize}`);
        break;
      }
      if (!metadataBudget.take({ inputBytes: cmdsize, records: 1, objects: 1, operations: 1, estimatedHeapBytes: 64 }, "load-command")) break;
      commands.push({ cmd, offset: p, size: cmdsize });
      try {
        if (cmd === LC_SEGMENT_64 && bits === 64) parseSegment64(r, p, cmdsize, image2, segmentOrder);
        else if (cmd === LC_SEGMENT && bits === 32) parseSegment32(r, p, cmdsize, image2, segmentOrder);
        else if (cmd === LC_SYMTAB) {
          if (cmdsize < 24) throw new Error(`invalid LC_SYMTAB size ${cmdsize}`);
          symtabs.push({ symoff: r.u32(p + 8), nsyms: r.u32(p + 12), stroff: r.u32(p + 16), strsize: r.u32(p + 20) });
        } else if (DYLIB_COMMANDS.has(cmd) || cmd === LC_ID_DYLIB) {
          if (cmdsize < 24) throw new Error(`invalid dylib command size ${cmdsize}`);
          parseDylib(r, p, cmdsize, image2, cmd === LC_ID_DYLIB);
        } else if (cmd === LC_MAIN && cmdsize >= 24) linkeditData.main = { entryoff: r.u64(p + 8), stacksize: r.u64(p + 16) };
        else if ((cmd === LC_THREAD || cmd === LC_UNIXTHREAD) && cmdsize >= 16) {
          const pc = parseThreadEntrypoint(r, p, cmdsize, cpu, bits);
          if (pc != null && linkeditData.threadEntry == null) linkeditData.threadEntry = pc;
        } else if (cmd === LC_VERSION_MIN_MACOSX || cmd === LC_VERSION_MIN_IPHONEOS || cmd === LC_VERSION_MIN_TVOS || cmd === LC_VERSION_MIN_WATCHOS) {
          if (cmdsize < 16) throw new Error(`invalid LC_VERSION_MIN size ${cmdsize}`);
          parseLegacyVersionMin(r, p, cmd, image2);
        } else if (cmd === LC_FUNCTION_STARTS && cmdsize >= 16) linkeditData.functionStarts = dataCommand(r, p);
        else if (cmd === LC_DYLD_CHAINED_FIXUPS && cmdsize >= 16) linkeditData.chainedFixups = dataCommand(r, p);
        else if (cmd === LC_DYLD_EXPORTS_TRIE && cmdsize >= 16) linkeditData.exportsTrie = dataCommand(r, p);
        else if ((cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) && cmdsize >= 48) dyldInfos.push(parseDyldInfo(r, p));
        else if (cmd === LC_BUILD_VERSION && cmdsize >= 24) parseBuildVersion(r, p, image2);
      } catch (e) {
        if (e?.code === "BINARY_SOURCE_RANGE_MISSING") throw e;
        image2.warnings.push(`load command 0x${cmd.toString(16)}: ${e.message}`);
      }
      p += cmdsize;
    }
    image2.metadata.loadCommands = commands.length;
    image2.metadata.segmentOrder = segmentOrder.map((s) => s.name);
    const text = image2.segments.find((s) => s.name === "__TEXT") || image2.segments.find((s) => s.perms.execute) || image2.segments[0];
    image2.imageBase = text ? text.address : 0n;
    if (linkeditData.main) {
      image2.entrypoint = image2.offsetToAddress(linkeditData.main.entryoff);
      image2.metadata.entrypointSource = "LC_MAIN";
    } else if (linkeditData.threadEntry != null) {
      image2.entrypoint = linkeditData.threadEntry;
      image2.metadata.entrypointSource = "LC_UNIXTHREAD";
    }
    if (image2.entrypoint != null && image2.entrypoint !== 0n) image2.functions.push(functionSeed(image2.entrypoint, { source: "entrypoint", confidence: 0.9 }));
    for (const st of symtabs) parseSymbolTable(r, st, image2, bits, metadataBudget);
    const hadFunctionStarts = !!linkeditData.functionStarts;
    if (linkeditData.functionStarts) parseFunctionStarts(r, linkeditData.functionStarts, image2, metadataBudget);
    let chainedImports = null;
    if (linkeditData.chainedFixups) chainedImports = parseChainedImports(r, linkeditData.chainedFixups, image2, metadataBudget);
    if (linkeditData.chainedFixups && chainedImports) parseChainedBindingSites(r, linkeditData.chainedFixups, image2, chainedImports, segmentOrder, metadataBudget);
    for (const info of dyldInfos) {
      parseClassicBindings(r, info.bind, image2, segmentOrder, "bind", metadataBudget);
      parseClassicBindings(r, info.weakBind, image2, segmentOrder, "weak-bind", metadataBudget);
      parseClassicBindings(r, info.lazyBind, image2, segmentOrder, "lazy-bind", metadataBudget);
      if (!linkeditData.exportsTrie && info.export.size) parseExportTrie(r, info.export, image2, metadataBudget);
    }
    if (linkeditData.exportsTrie) parseExportTrie(r, linkeditData.exportsTrie, image2, metadataBudget);
    const namesByAddr = /* @__PURE__ */ new Map();
    const nameIndexEntries = image2.symbols.length + image2.exports.length;
    if (metadataBudget.take({ objects: nameIndexEntries, operations: nameIndexEntries, estimatedHeapBytes: nameIndexEntries * 48 }, "name-address-index")) {
      for (const sym of image2.symbols) if (sym.defined && sym.address) namesByAddr.set(sym.address.toString(), sym.name);
      for (const ex of image2.exports) if (ex.address) namesByAddr.set(ex.address.toString(), ex.name);
    }
    if (hadFunctionStarts) {
      for (const f of image2.functions) if (!f.name) f.name = namesByAddr.get(f.address.toString()) || null;
      const provenStarts = new Set(image2.functions.filter((f) => f.source !== "export").map((f) => f.address.toString()));
      image2.functions = image2.functions.filter((f) => f.source !== "export" || provenStarts.has(f.address.toString()));
    } else {
      for (const sym of image2.symbols) {
        if (!sym.defined || !sym.address) continue;
        const sec = image2.sectionAt(sym.address);
        if (sec && sec.perms.execute && sym.name !== "__mh_execute_header" && metadataBudget.take({ objects: 1, operations: 1, estimatedHeapBytes: 128 }, "symbol-function-fallback")) image2.functions.push(functionSeed(sym.address, { name: sym.name, source: "symbol", confidence: 0.9 }));
      }
    }
    image2.metadata.machoMetadata = metadataBudget.snapshot();
    return image2.finalize();
  }
  function validateMappedRange(label, address, size, fileOffset, fileSize, image2) {
    const inputSize = BigInt(image2.bytes?.length ?? image2.fileSize ?? 0);
    if (fileSize > size) throw new Error(`${label} file size exceeds VM size`);
    if (fileOffset > inputSize || fileSize > inputSize - fileOffset) throw new Error(`${label} file range exceeds input`);
    return { vmEnd: address + size, fileEnd: fileOffset + fileSize };
  }
  function validateSectionRange(label, saddr, ssize, fileOffset, fileSize, seg, image2, zeroFill) {
    if (saddr < seg.address || saddr > seg.address + seg.size || ssize > seg.address + seg.size - saddr) throw new Error(`${label} VM range escapes parent segment`);
    if (!zeroFill) {
      if (fileOffset < seg.fileOffset || fileOffset > seg.fileOffset + seg.fileSize || fileSize > seg.fileOffset + seg.fileSize - fileOffset) throw new Error(`${label} file range escapes parent segment`);
      validateMappedRange(label, saddr, ssize, fileOffset, fileSize, image2);
    }
  }
  function parseSegment64(r, p, cmdsize, image2, order) {
    if (cmdsize < 72) throw new Error(`invalid LC_SEGMENT_64 size ${cmdsize}`);
    const name = r.ascii(p + 8, 16);
    const address = r.u64(p + 24);
    const size = r.u64(p + 32);
    const fileOffset = r.u64(p + 40);
    const fileSize = r.u64(p + 48);
    const initprot = r.i32(p + 60);
    const nsects = r.u32(p + 64);
    if (nsects > Math.floor((cmdsize - 72) / 80)) throw new Error(`invalid section count ${nsects}`);
    const flags = r.u32(p + 68);
    validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image2);
    const seg = image2.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: "LC_SEGMENT_64" });
    order.push(seg);
    let q = p + 72;
    for (let i = 0; i < nsects; i++, q += 80) {
      r.check(q, 80);
      const sectname = r.ascii(q, 16);
      const segname = r.ascii(q + 16, 16);
      const saddr = r.u64(q + 32);
      const ssize = r.u64(q + 40);
      const offset = r.u32(q + 48);
      const sflags = r.u32(q + 64);
      const zeroFill = (sflags & 255) === 1 || (sflags & 255) === 12 || (sflags & 255) === 18;
      const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;
      validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image2, zeroFill);
      image2.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image2.sections.length + 1 });
    }
  }
  function parseSegment32(r, p, cmdsize, image2, order) {
    if (cmdsize < 56) throw new Error(`invalid LC_SEGMENT size ${cmdsize}`);
    const name = r.ascii(p + 8, 16);
    const address = BigInt(r.u32(p + 24));
    const size = BigInt(r.u32(p + 28));
    const fileOffset = BigInt(r.u32(p + 32));
    const fileSize = BigInt(r.u32(p + 36));
    const initprot = r.i32(p + 44);
    const nsects = r.u32(p + 48);
    if (nsects > Math.floor((cmdsize - 56) / 68)) throw new Error(`invalid section count ${nsects}`);
    const flags = r.u32(p + 52);
    validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image2);
    const seg = image2.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: "LC_SEGMENT" });
    order.push(seg);
    let q = p + 56;
    for (let i = 0; i < nsects; i++, q += 68) {
      r.check(q, 68);
      const sectname = r.ascii(q, 16);
      const segname = r.ascii(q + 16, 16);
      const saddr = BigInt(r.u32(q + 32));
      const ssize = BigInt(r.u32(q + 36));
      const offset = r.u32(q + 40);
      const sflags = r.u32(q + 56);
      const zeroFill = (sflags & 255) === 1 || (sflags & 255) === 12 || (sflags & 255) === 18;
      const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;
      validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image2, zeroFill);
      image2.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image2.sections.length + 1 });
    }
  }
  function parseDylib(r, p, cmdsize, image2, isId) {
    const nameoff = r.u32(p + 8);
    if (nameoff >= cmdsize) return;
    const name = r.cstring(p + nameoff, cmdsize - nameoff);
    if (isId) image2.metadata.installName = name;
    else if (name) image2.libraries.push(name);
  }
  function parseBuildVersion(r, p, image2) {
    const platform = r.u32(p + 8);
    const minos = r.u32(p + 12);
    const sdk = r.u32(p + 16);
    image2.metadata.buildVersion = { platform, platformName: platformName(platform), minos: version32(minos), sdk: version32(sdk), source: "LC_BUILD_VERSION" };
    image2.platform = platformName(platform) || image2.platform;
  }
  function parseLegacyVersionMin(r, p, cmd, image2) {
    if (image2.metadata.buildVersion?.source === "LC_BUILD_VERSION") return;
    const platform = cmd === LC_VERSION_MIN_MACOSX ? 1 : cmd === LC_VERSION_MIN_IPHONEOS ? 2 : cmd === LC_VERSION_MIN_TVOS ? 3 : 4;
    image2.metadata.buildVersion = { platform, platformName: platformName(platform), minos: version32(r.u32(p + 8)), sdk: version32(r.u32(p + 12)), source: "LC_VERSION_MIN" };
    image2.platform = platformName(platform) || image2.platform;
  }
  function parseThreadEntrypoint(r, p, cmdsize, cpu, bits) {
    const end = p + cmdsize;
    let q = p + 8;
    while (q + 8 <= end) {
      const flavor = r.u32(q);
      const count = r.u32(q + 4);
      const state = q + 8;
      const stateBytes = count * 4;
      if (!Number.isSafeInteger(stateBytes) || stateBytes < 0 || state + stateBytes > end) return null;
      const arch = cpuName(cpu);
      if (arch === "arm64" && flavor === 6 && stateBytes >= 272) return r.u64(state + 264);
      if (arch === "x86_64" && flavor === 4 && stateBytes >= 136) return r.u64(state + 128);
      if (arch === "arm" && bits === 32 && flavor === 1 && stateBytes >= 64) return BigInt(r.u32(state + 60));
      q = state + stateBytes;
    }
    return null;
  }
  function parseDyldInfo(r, p) {
    return {
      rebase: { offset: r.u32(p + 8), size: r.u32(p + 12) },
      bind: { offset: r.u32(p + 16), size: r.u32(p + 20) },
      weakBind: { offset: r.u32(p + 24), size: r.u32(p + 28) },
      lazyBind: { offset: r.u32(p + 32), size: r.u32(p + 36) },
      export: { offset: r.u32(p + 40), size: r.u32(p + 44) }
    };
  }
  function parseSymbolTable(r, st, image2, bits, sharedBudget = null) {
    const budget = ensureMachOMetadataBudget(image2, sharedBudget);
    const ent = bits === 64 ? 16 : 12;
    if (st.symoff + st.nsyms * ent > r.length || st.stroff + st.strsize > r.length) {
      image2.warnings.push("Mach-O symbol table is truncated");
      return;
    }
    for (let i = 0; i < st.nsyms; i++) {
      if (!budget.take({ inputBytes: ent, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 224 }, "symbol-record")) break;
      const p = st.symoff + i * ent;
      const strx = r.u32(p);
      const type = r.u8(p + 4);
      const sect = r.u8(p + 5);
      const desc = r.u16(p + 6);
      const value = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 8));
      if (type & 224) continue;
      const name = strx < st.strsize ? r.cstring(st.stroff + strx, st.strsize - strx) : "";
      if (!name) continue;
      if (!budget.take({ stringBytes: name.length * 2, estimatedHeapBytes: name.length * 2 + 32 }, "symbol-name")) break;
      const ntype = type & 14;
      const external = !!(type & 1);
      const isUndefinedType = ntype === 0;
      const commonSymbol = isUndefinedType && value !== 0n;
      const undefinedSymbol = isUndefinedType && !commonSymbol;
      const sym = {
        name,
        address: isUndefinedType ? 0n : value,
        size: commonSymbol ? value : null,
        common: commonSymbol,
        kind: ntype === 14 ? "section" : commonSymbol ? "common" : undefinedSymbol ? "undefined" : "other",
        binding: external ? "global" : "local",
        defined: !isUndefinedType,
        sectionIndex: sect,
        desc,
        source: "LC_SYMTAB"
      };
      image2.symbols.push(sym);
      if (undefinedSymbol && external) {
        const ordinal = desc >>> 8 & 255;
        image2.imports.push({ name, library: dylibForOrdinal2(image2, ordinal), ordinal, weak: !!(desc & 64), source: "symbol-table", sites: [] });
      } else if (!isUndefinedType && external && value !== 0n) {
        image2.exports.push({ name, address: value, kind: "symbol", source: "symbol-table" });
      }
      void sect;
    }
  }
  function parseFunctionStarts(r, dc, image2, sharedBudget = null) {
    const budget = ensureMachOMetadataBudget(image2, sharedBudget);
    if (!dc.size || dc.offset > r.length || dc.size > r.length - dc.offset) return;
    let p = dc.offset;
    const end = dc.offset + dc.size;
    let addr = image2.imageBase;
    const alignment = image2.arch === "arm64" || image2.arch === "arm64e" || image2.arch === "arm64_32" ? 4n : image2.arch === "arm" ? 2n : 1n;
    const status = image2.metadata.functionStarts = { complete: true, recovered: 0, partialReason: null };
    while (p < end) {
      if (!budget.take({ records: 1, operations: 1, estimatedHeapBytes: 32 }, "function-start-record")) {
        status.complete = false;
        status.partialReason = "metadata-budget";
        break;
      }
      let x;
      try {
        x = r.uleb(p, 10, end);
      } catch (e) {
        if (e?.code === "BINARY_SOURCE_RANGE_MISSING") throw e;
        status.complete = false;
        status.partialReason = "truncated-leb";
        image2.warnings.push(`LC_FUNCTION_STARTS: ${e.message}`);
        break;
      }
      p = x.next;
      if (x.value === 0n) break;
      const next = addr + x.value;
      if (next < addr) {
        image2.warnings.push("LC_FUNCTION_STARTS address overflow");
        break;
      }
      addr = next;
      const seg = image2.segmentAt(addr);
      if (!seg || !seg.perms.execute || alignment > 1n && addr % alignment !== 0n) {
        image2.warnings.push(`invalid LC_FUNCTION_STARTS entry 0x${addr.toString(16)}`);
        continue;
      }
      if (!budget.take({ inputBytes: x.bytes, objects: 1, estimatedHeapBytes: 128 }, "function-start-output")) {
        status.complete = false;
        status.partialReason = "metadata-budget";
        break;
      }
      image2.functions.push(functionSeed(addr, { source: "function_starts", confidence: 0.995 }));
      status.recovered++;
    }
  }
  function dataCommand(r, p) {
    return { offset: r.u32(p + 8), size: r.u32(p + 12) };
  }
  function vmPerms(v) {
    return { read: !!(v & 1), write: !!(v & 2), execute: !!(v & 4) };
  }
  function dylibForOrdinal2(image2, ordinal) {
    if (ordinal === 0) return null;
    if (ordinal === -1 || ordinal === 255) return "<main-executable>";
    if (ordinal === -2 || ordinal === 254) return "<flat-lookup>";
    if (ordinal === -3 || ordinal === 253) return "<weak-lookup>";
    return ordinal > 0 ? image2.libraries[ordinal - 1] || null : null;
  }
  function cpuName(cpu) {
    const u = cpu >>> 0;
    return { 7: "x86", 12: "arm", 18: "ppc", 16777223: "x86_64", 16777228: "arm64", 33554444: "arm64_32" }[u] || `cpu-${u}`;
  }
  function subtypeBase(subtype) {
    return subtype >>> 0 & 16777215;
  }
  function cpuArchName(cpu, subtype) {
    return cpuName(cpu) === "arm64" && subtypeBase(subtype) === 2 ? "arm64e" : cpuName(cpu);
  }
  function sliceArchName(slice) {
    return cpuArchName(slice.cpu, slice.subtype);
  }
  function platformName(p) {
    return { 1: "macOS", 2: "iOS", 3: "tvOS", 4: "watchOS", 6: "macCatalyst", 7: "iOS-simulator", 8: "tvOS-simulator", 9: "watchOS-simulator", 10: "driverKit", 11: "visionOS", 12: "visionOS-simulator" }[p] || `apple-platform-${p}`;
  }
  function version32(v) {
    return `${v >>> 16 & 65535}.${v >>> 8 & 255}.${v & 255}`;
  }
  function machoKind(bytes) {
    if (bytes.length < 4) return null;
    const r = new ByteView(bytes);
    const s = [r.u8(0), r.u8(1), r.u8(2), r.u8(3)].map((x) => x.toString(16).padStart(2, "0")).join("");
    if (s === "cefaedfe") return { fat: false, bits: 32, littleEndian: true };
    if (s === "cffaedfe") return { fat: false, bits: 64, littleEndian: true };
    if (s === "feedface") return { fat: false, bits: 32, littleEndian: false };
    if (s === "feedfacf") return { fat: false, bits: 64, littleEndian: false };
    if (s === "cafebabe") return { fat: true, bits: 32, littleEndian: false };
    if (s === "cafebabf") return { fat: true, bits: 64, littleEndian: false };
    if (s === "bebafeca") return { fat: true, bits: 32, littleEndian: true };
    if (s === "bfbafeca") return { fat: true, bits: 64, littleEndian: true };
    return null;
  }
  function selectFatSlice(bytes, kind, preferredArch) {
    const r = new ByteView(bytes, { littleEndian: kind.littleEndian });
    const n = r.u32(4);
    if (n > 128) throw new Error(`unreasonable Mach-O slice count ${n}`);
    const all = [];
    let p = 8;
    for (let i = 0; i < n; i++) {
      if (kind.bits === 64) {
        const cpu = r.i32(p), subtype = r.i32(p + 4), offset = r.u64(p + 8), size = r.u64(p + 16);
        all.push({ cpu, subtype, offset, size });
        p += 32;
      } else {
        const cpu = r.i32(p), subtype = r.i32(p + 4), offset = BigInt(r.u32(p + 8)), size = BigInt(r.u32(p + 12));
        all.push({ cpu, subtype, offset, size });
        p += 20;
      }
    }
    const valid = all.filter((s) => s.offset >= 0n && s.size > 0n && s.offset + s.size <= BigInt(bytes.length));
    const want = preferredArch ? valid.find((s) => sliceArchName(s) === preferredArch) : null;
    if (preferredArch && !want) throw new Error(`requested Mach-O architecture ${preferredArch} is not present in the universal binary`);
    const chosen = want || valid.find((s) => sliceArchName(s) === "arm64e") || valid.find((s) => sliceArchName(s) === "arm64") || valid.find((s) => sliceArchName(s) === "x86_64") || valid[0];
    return chosen ? { ...chosen, all } : null;
  }

  // js/binary/elf-unwind.js
  function parseEhFrameHeader(r, sec, image2, bits, budget = null) {
    if (sec.size < 4n || sec.offset + sec.size > BigInt(r.length)) return;
    let p = Number(sec.offset);
    const end = Number(sec.offset + sec.size);
    const version = r.u8(p++);
    const ehFrameEnc = r.u8(p++);
    const countEnc = r.u8(p++);
    const tableEnc = r.u8(p++);
    if (version !== 1 || tableEnc === 255) return;
    const ctx = {
      secAddress: sec.addr,
      secOffset: Number(sec.offset),
      textBase: (image2.segments.find((s) => s.perms.execute) || image2.segments[0] || { address: 0n }).address,
      image: image2,
      bits,
      functionBase: null
    };
    try {
      const frame = decodeEhValue(r, p, ehFrameEnc, ctx, end);
      p = frame.next;
      const countX = decodeEhValue(r, p, countEnc, ctx, end);
      p = countX.next;
      const count = Number(countX.raw);
      if (!Number.isSafeInteger(count) || count < 0 || count > 1e7) return;
      let added = 0;
      for (let i = 0; i < count && p < end; i++) {
        if (budget && !budget.take({ records: 1, operations: 2, inputBytes: 2, estimatedHeapBytes: 32 }, "eh-frame-table")) break;
        const initial = decodeEhValue(r, p, tableEnc, ctx, end);
        p = initial.next;
        const fde = decodeEhValue(r, p, tableEnc, ctx, end);
        p = fde.next;
        if (initial.value == null || initial.value === 0n) continue;
        const codeSec = image2.sectionAt(initial.value);
        const codeSeg = typeof image2.segmentAt === "function" ? image2.segmentAt(initial.value) : null;
        if (codeSec?.perms?.execute || codeSeg?.perms?.execute) {
          if (budget && !budget.take({ objects: 1, operations: 1, estimatedHeapBytes: 128 }, "eh-frame-function")) break;
          image2.functions.push(functionSeed(initial.value, { source: "unwind", confidence: 0.985 }));
          added++;
        }
        void fde;
      }
      image2.metadata.ehFrameHeader = { version, ehFrameEnc, countEnc, tableEnc, declaredFunctions: count, recoveredFunctions: added };
      void frame;
    } catch (e) {
      if (e?.code === "BINARY_SOURCE_RANGE_MISSING") throw e;
      image2.warnings.push(`.eh_frame_hdr: ${e.message}`);
    }
  }
  function decodeEhValue(r, p0, enc, ctx, end = r.length) {
    if (enc === 255) return { value: null, raw: 0n, next: p0 };
    const format = enc & 15;
    const application = enc & 112;
    const indirect = !!(enc & 128);
    const ptrBytes = ctx.bits === 64 ? 8 : 4;
    let p = p0;
    if (application === 80) p = Math.ceil(p / ptrBytes) * ptrBytes;
    const requireSpan = (n) => {
      if (!Number.isSafeInteger(p) || !Number.isSafeInteger(end) || p < 0 || n < 0 || p > end || n > end - p)
        throw new Error("DW_EH_PE value crosses .eh_frame_hdr boundary");
    };
    let raw, next;
    if (format === 0) {
      requireSpan(ptrBytes);
      raw = ctx.bits === 64 ? r.u64(p) : BigInt(r.u32(p));
      next = p + ptrBytes;
    } else if (format === 1) {
      const x = r.uleb(p, 10, end);
      raw = x.value;
      next = x.next;
    } else if (format === 2) {
      requireSpan(2);
      raw = BigInt(r.u16(p));
      next = p + 2;
    } else if (format === 3) {
      requireSpan(4);
      raw = BigInt(r.u32(p));
      next = p + 4;
    } else if (format === 4) {
      requireSpan(8);
      raw = r.u64(p);
      next = p + 8;
    } else if (format === 9) {
      const x = r.sleb(p, 10, end);
      raw = x.value;
      next = x.next;
    } else if (format === 10) {
      requireSpan(2);
      raw = BigInt(r.i16(p));
      next = p + 2;
    } else if (format === 11) {
      requireSpan(4);
      raw = BigInt(r.i32(p));
      next = p + 4;
    } else if (format === 12) {
      requireSpan(8);
      raw = r.i64(p);
      next = p + 8;
    } else throw new Error(`unsupported DW_EH_PE format 0x${format.toString(16)}`);
    let value = raw;
    const fieldAddress = ctx.secAddress + BigInt(p - ctx.secOffset);
    if (application === 16) value += fieldAddress;
    else if (application === 32) value += ctx.textBase;
    else if (application === 48) value += ctx.secAddress;
    else if (application === 64) {
      if (ctx.functionBase == null) throw new Error("DW_EH_PE_funcrel requires a function base");
      value += ctx.functionBase;
    } else if (application !== 0 && application !== 80) throw new Error(`unsupported DW_EH_PE application 0x${application.toString(16)}`);
    if (indirect) {
      const off = ctx.image.addressToOffset(value);
      if (off == null || off + BigInt(ptrBytes) > BigInt(r.length)) throw new Error(`DW_EH_PE_indirect target 0x${value.toString(16)} is not readable`);
      value = ctx.bits === 64 ? r.u64(Number(off)) : BigInt(r.u32(Number(off)));
    }
    return { value, raw, next };
  }

  // js/binary/dynamic-symbol-budget.js
  var DEFAULT_DYNAMIC_SYMBOL_LIMITS = Object.freeze({
    maxSymbolRecords: 1e5,
    maxOutputObjects: 5e5,
    maxInputBytes: 64 * 1024 * 1024,
    maxOperations: 2e6,
    maxWallMs: 2e3,
    maxEstimatedBytes: 96 * 1024 * 1024
  });
  function positiveLimit(value, fallback) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  }
  function createDynamicSymbolBudget({ limits = {}, onLimit = null } = {}) {
    const resolved = {
      maxSymbolRecords: positiveLimit(limits.maxSymbolRecords, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxSymbolRecords),
      maxOutputObjects: positiveLimit(limits.maxOutputObjects, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxOutputObjects),
      maxInputBytes: positiveLimit(limits.maxInputBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxInputBytes),
      maxOperations: positiveLimit(limits.maxOperations, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxOperations),
      maxWallMs: positiveLimit(limits.maxWallMs, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxWallMs),
      maxEstimatedBytes: positiveLimit(limits.maxEstimatedBytes, DEFAULT_DYNAMIC_SYMBOL_LIMITS.maxEstimatedBytes)
    };
    const now = typeof limits.now === "function" ? limits.now : Date.now;
    const started = now();
    let inputBytes = 0;
    let operations = 0;
    let outputObjects = 0;
    let estimatedBytes = 0;
    let stopped = false;
    let reason = null;
    const stop = (message) => {
      if (!stopped) {
        stopped = true;
        reason = message;
        if (typeof onLimit === "function") onLimit(message);
      }
      return false;
    };
    const wallOkay = (stage) => {
      if (stopped) return false;
      if (now() - started > resolved.maxWallMs) return stop(`${stage} exceeded ${resolved.maxWallMs} ms wall-clock budget`);
      return true;
    };
    return {
      limits: resolved,
      get stopped() {
        return stopped;
      },
      get reason() {
        return reason;
      },
      claimInput(bytes, source2 = "dynamic symbol table") {
        if (stopped) return false;
        if (!Number.isSafeInteger(bytes) || bytes < 0) return stop(`${source2} input size is not safely representable`);
        if (bytes > resolved.maxInputBytes - inputBytes) return stop(`${source2} input bytes exceed ${resolved.maxInputBytes}`);
        inputBytes += bytes;
        return true;
      },
      step(cost = 1, stage = "dynamic symbol decode") {
        if (stopped) return false;
        operations += cost;
        if (!Number.isSafeInteger(operations) || operations > resolved.maxOperations) return stop(`${stage} exceeds ${resolved.maxOperations} operations`);
        return operations === 1 || (operations & 4095) === 0 ? wallOkay(stage) : true;
      },
      claimOutput(count = 1, bytesPerObject = 128, source2 = "dynamic symbol decode") {
        if (stopped) return false;
        if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(bytesPerObject) || bytesPerObject < 0) return stop(`${source2} output estimate is invalid`);
        const bytes = count * bytesPerObject;
        if (!Number.isSafeInteger(bytes)) return stop(`${source2} output estimate exceeds safe integer range`);
        if (count > resolved.maxOutputObjects - outputObjects) return stop(`${source2} output objects exceed ${resolved.maxOutputObjects}`);
        if (bytes > resolved.maxEstimatedBytes - estimatedBytes) return stop(`${source2} estimated memory exceeds ${resolved.maxEstimatedBytes} bytes`);
        outputObjects += count;
        estimatedBytes += bytes;
        return true;
      },
      checkWall(stage = "dynamic symbol decode") {
        return wallOkay(stage);
      },
      snapshot() {
        return { ...resolved, inputBytes, operations, outputObjects, estimatedBytes, stopped, reason };
      }
    };
  }

  // js/binary/relocation-budget.js
  var DEFAULT_RELOCATION_BUDGET_LIMITS = Object.freeze({
    maxOutput: 25e4,
    maxInputBytes: 32 * 1024 * 1024,
    maxOperations: 4e6,
    maxWallMs: 1500
  });
  function positiveLimit2(value, fallback) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  }
  function createRelocationBudget({ limits = {}, onLimit = null } = {}) {
    const resolved = {
      maxOutput: positiveLimit2(limits.maxOutput, DEFAULT_RELOCATION_BUDGET_LIMITS.maxOutput),
      maxInputBytes: positiveLimit2(limits.maxInputBytes, DEFAULT_RELOCATION_BUDGET_LIMITS.maxInputBytes),
      maxOperations: positiveLimit2(limits.maxOperations, DEFAULT_RELOCATION_BUDGET_LIMITS.maxOperations),
      maxWallMs: positiveLimit2(limits.maxWallMs, DEFAULT_RELOCATION_BUDGET_LIMITS.maxWallMs)
    };
    const now = typeof limits.now === "function" ? limits.now : Date.now;
    const started = now();
    let inputBytes = 0;
    let operations = 0;
    let stopped = false;
    let reason = null;
    const stop = (message) => {
      if (!stopped) {
        stopped = true;
        reason = message;
        if (typeof onLimit === "function") onLimit(message);
      }
      return false;
    };
    return {
      limits: resolved,
      get stopped() {
        return stopped;
      },
      get reason() {
        return reason;
      },
      claimInput(bytes, source2 = "relocation table") {
        if (stopped) return false;
        if (!Number.isSafeInteger(bytes) || bytes < 0) return stop(`${source2} input size is not safely representable`);
        if (bytes > resolved.maxInputBytes - inputBytes) return stop(`${source2} input bytes exceed ${resolved.maxInputBytes}`);
        inputBytes += bytes;
        return true;
      },
      step(cost = 1) {
        if (stopped) return false;
        operations += cost;
        if (!Number.isSafeInteger(operations) || operations > resolved.maxOperations) return stop(`decode work exceeds ${resolved.maxOperations} operations`);
        if (operations === 1 || (operations & 4095) === 0) {
          if (now() - started > resolved.maxWallMs) return stop(`decode time exceeds ${resolved.maxWallMs} ms`);
        }
        return true;
      },
      push(out, item, source2 = "relocation table") {
        if (stopped) return false;
        if (out.length >= resolved.maxOutput) return stop(`${source2} expanded relocations exceed ${resolved.maxOutput}`);
        out.push(item);
        return true;
      },
      snapshot(output = 0) {
        return { inputBytes, operations, output, stopped, reason, ...resolved };
      }
    };
  }

  // js/binary/elf-mapping.js
  function mappedELFFileRangeForVa(image2, va) {
    const address = BigInt(va);
    for (const segment of image2?.segments || []) {
      const start = BigInt(segment.address ?? 0);
      const fileSize = BigInt(segment.fileSize ?? 0);
      if (fileSize <= 0n || address < start || address >= start + fileSize) continue;
      const delta = address - start;
      const fileStart = BigInt(segment.fileOffset ?? 0) + delta;
      const fileEnd = BigInt(segment.fileOffset ?? 0) + fileSize;
      if (fileStart > BigInt(Number.MAX_SAFE_INTEGER) || fileEnd > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return { start: Number(fileStart), end: Number(fileEnd), segment, address };
    }
    return null;
  }
  function mappedELFFileSpanForVa(image2, va, size) {
    const n = typeof size === "bigint" ? size : BigInt(size);
    if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const range = mappedELFFileRangeForVa(image2, va);
    if (!range) return null;
    const bytes = Number(n);
    if (bytes > range.end - range.start) return null;
    return { ...range, spanEnd: range.start + bytes, size: bytes };
  }
  function executableELFRange(image2, address, size = 0n, sectionIndex = null) {
    const start = BigInt(address);
    const extent = BigInt(size ?? 0n);
    if (extent < 0n) return null;
    const fits = (owner) => {
      if (!owner?.perms?.execute) return false;
      const lo = BigInt(owner.address ?? 0), hi = lo + BigInt(owner.size ?? 0);
      if (start < lo || start >= hi) return false;
      return extent === 0n || extent <= hi - start;
    };
    if (Number.isInteger(sectionIndex)) {
      const section2 = (image2.sections || []).find((s) => s.index === sectionIndex) || null;
      if (fits(section2)) return section2;
      return null;
    }
    const section = (image2.sections || []).find(fits) || null;
    if (section) return section;
    return (image2.segments || []).find(fits) || null;
  }

  // js/binary/elf-extended.js
  var DT_RELRSZ = 35n;
  var DT_RELR = 36n;
  var DT_RELRENT = 37n;
  var DT_ANDROID_REL = 0x6000000fn;
  var DT_ANDROID_RELSZ = 0x60000010n;
  var DT_ANDROID_RELA = 0x60000011n;
  var DT_ANDROID_RELASZ = 0x60000012n;
  var DT_VERSYM = 0x6ffffff0n;
  var DT_VERDEF = 0x6ffffffcn;
  var DT_VERDEFNUM = 0x6ffffffdn;
  var DT_VERNEED = 0x6ffffffen;
  var DT_VERNEEDNUM = 0x6fffffffn;
  var GROUPED_BY_INFO = 1n;
  var GROUPED_BY_OFFSET_DELTA = 2n;
  var GROUPED_BY_ADDEND = 4n;
  var GROUP_HAS_ADDEND = 8n;
  function one(tags, tag) {
    return tags.get(tag)?.[0] ?? null;
  }
  function safe(v) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  function partial(image2, message) {
    image2.metadata.programDynamicPartial = true;
    const list = image2.metadata.programDynamicDiagnostics ||= [];
    if (!list.includes(message)) list.push(message);
    image2.warnings.push(`PT_DYNAMIC: ${message}`);
  }
  function dynamicBudget(image2, limits = {}) {
    return createRelocationBudget({
      limits,
      onLimit(message) {
        partial(image2, `relocation decode budget exceeded: ${message}`);
      }
    });
  }
  function relocationContext(image2, context) {
    const c = context && typeof context === "object" ? context : {};
    return {
      out: Array.isArray(c.out) ? c.out : [],
      budget: c.budget || dynamicBudget(image2, c.limits || {})
    };
  }
  function collectRelrRelocations(r, tags, image2, bits, context = null) {
    const { out, budget } = relocationContext(image2, context);
    const va = one(tags, DT_RELR), size64 = one(tags, DT_RELRSZ);
    if (va == null || size64 == null || size64 === 0n || budget.stopped) return out;
    const word2 = bits === 64 ? 8 : 4, ent = one(tags, DT_RELRENT) ?? BigInt(word2);
    if (ent !== BigInt(word2)) {
      partial(image2, `DT_RELRENT ${ent} does not match pointer size ${word2}`);
      return out;
    }
    const size = safe(size64), span = size == null ? null : mappedELFFileSpanForVa(image2, va, size), off = span?.start ?? null;
    if (off == null || size == null) {
      partial(image2, "DT_RELR table crosses a file-backed PT_LOAD boundary");
      return out;
    }
    if (!budget.claimInput(size, "DT_RELR")) return out;
    if (size % word2) partial(image2, "DT_RELRSZ is not a multiple of DT_RELRENT");
    let base = 0n;
    const wordBits = BigInt(word2 * 8);
    const count = Math.floor(size / word2);
    outer: for (let i = 0; i < count; i++) {
      if (!budget.step()) break;
      const entry = word2 === 8 ? r.u64(off + i * word2) : BigInt(r.u32(off + i * word2));
      if ((entry & 1n) === 0n) {
        if (!budget.push(out, { address: entry, symIndex: 0, type: null, addend: null, source: "PT_DYNAMIC-RELR", relative: true }, "DT_RELR")) break;
        base = entry + BigInt(word2);
        continue;
      }
      for (let bit = 1n; bit < wordBits; bit++) {
        if (!budget.step()) break outer;
        if (entry & 1n << bit) {
          if (!budget.push(out, { address: base + (bit - 1n) * BigInt(word2), symIndex: 0, type: null, addend: null, source: "PT_DYNAMIC-RELR", relative: true }, "DT_RELR")) break outer;
        }
      }
      base += (wordBits - 1n) * BigInt(word2);
    }
    return out;
  }
  function readSleb(r, state, end) {
    let value = 0n, shift = 0n, byte = 0;
    for (let i = 0; i < 10; i++) {
      if (state.p >= end) throw new Error("truncated SLEB128");
      byte = r.u8(state.p++);
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
      if (!(byte & 128)) {
        if (byte & 64 && shift < 64n) value |= -1n << shift;
        return value;
      }
    }
    throw new Error("SLEB128 exceeds 10 bytes");
  }
  function decodeAndroidTable(r, va, size64, image2, bits, rela, source2, budget, out) {
    if (budget.stopped) return out;
    const size = safe(size64), span = size == null ? null : mappedELFFileSpanForVa(image2, va, size), off = span?.start ?? null;
    if (off == null || size == null) {
      partial(image2, `${source2} table crosses a file-backed PT_LOAD boundary`);
      return out;
    }
    if (!budget.claimInput(size, source2)) return out;
    const end = off + size;
    if (size < 4 || r.u8(off) !== 65 || r.u8(off + 1) !== 80 || r.u8(off + 2) !== 83 || r.u8(off + 3) !== 50) {
      partial(image2, `${source2} is not APS2 encoded`);
      return out;
    }
    const st = { p: off + 4 };
    try {
      const relocationCount = readSleb(r, st, end);
      if (relocationCount < 0n) throw new Error("negative relocation count");
      let relocationOffset = readSleb(r, st, end), relocationAddend = 0n, decoded = 0n;
      while (decoded < relocationCount && !budget.stopped) {
        if (!budget.step()) break;
        const groupSize = readSleb(r, st, end), flags = readSleb(r, st, end);
        if (groupSize <= 0n || groupSize > relocationCount - decoded) throw new Error("invalid relocation group size");
        const groupedDelta = !!(flags & GROUPED_BY_OFFSET_DELTA), groupedInfo = !!(flags & GROUPED_BY_INFO), hasAddend = !!(flags & GROUP_HAS_ADDEND), groupedAddend = !!(flags & GROUPED_BY_ADDEND);
        const groupDelta = groupedDelta ? readSleb(r, st, end) : 0n, groupInfo = groupedInfo ? readSleb(r, st, end) : 0n, groupAddend = hasAddend && groupedAddend ? readSleb(r, st, end) : 0n;
        for (let i = 0n; i < groupSize && !budget.stopped; i++, decoded++) {
          if (!budget.step()) break;
          relocationOffset += groupedDelta ? groupDelta : readSleb(r, st, end);
          const info = groupedInfo ? groupInfo : readSleb(r, st, end);
          if (hasAddend) relocationAddend += groupedAddend ? groupAddend : readSleb(r, st, end);
          else if (rela) relocationAddend = 0n;
          if (relocationOffset < 0n || info < 0n) throw new Error("negative relocation field");
          const symIndex = bits === 64 ? Number(info >> 32n) : Number(info >> 8n), type = bits === 64 ? Number(info & 0xffffffffn) : Number(info & 0xffn);
          if (!Number.isSafeInteger(symIndex) || !Number.isSafeInteger(type)) throw new Error("relocation info exceeds safe integer range");
          if (!budget.push(out, { address: relocationOffset, symIndex, type, addend: rela ? relocationAddend : null, source: source2 }, source2)) break;
        }
      }
    } catch (error) {
      if (!budget.stopped) partial(image2, `${source2}: ${error.message}`);
    }
    return out;
  }
  function collectAndroidPackedRelocations(r, tags, image2, bits, context = null) {
    const { out, budget } = relocationContext(image2, context);
    const rel = one(tags, DT_ANDROID_REL), relsz = one(tags, DT_ANDROID_RELSZ), rela = one(tags, DT_ANDROID_RELA), relasz = one(tags, DT_ANDROID_RELASZ);
    if (rel != null && relsz != null) decodeAndroidTable(r, rel, relsz, image2, bits, false, "PT_DYNAMIC-ANDROID-REL", budget, out);
    if (!budget.stopped && rela != null && relasz != null) decodeAndroidTable(r, rela, relasz, image2, bits, true, "PT_DYNAMIC-ANDROID-RELA", budget, out);
    return out;
  }
  function symbolBudgetContext(image2, context) {
    const c = context && typeof context === "object" ? context : {};
    return c.budget || createDynamicSymbolBudget({
      limits: c.limits || {},
      onLimit(message) {
        partial(image2, `dynamic symbol decode budget exceeded: ${message}`);
      }
    });
  }
  function parseDynamicSymbolVersions(r, tags, image2, symbolCount, stringAt, context = null) {
    const out = /* @__PURE__ */ new Map(), versym = one(tags, DT_VERSYM);
    if (versym == null || symbolCount <= 0) return out;
    const budget = symbolBudgetContext(image2, context);
    const count = Math.min(symbolCount, budget.limits.maxSymbolRecords);
    if (symbolCount > count) partial(image2, `DT_VERSYM symbol count ${symbolCount} exceeds record limit ${count}; clamped`);
    const vspan = mappedELFFileSpanForVa(image2, versym, count * 2);
    if (!vspan) {
      partial(image2, "DT_VERSYM table crosses a file-backed PT_LOAD boundary");
      return out;
    }
    const voff = vspan.start;
    if (!budget.claimInput(count * 2, "DT_VERSYM")) return out;
    const names = /* @__PURE__ */ new Map();
    const verdef = one(tags, DT_VERDEF), verdefnum = safe(one(tags, DT_VERDEFNUM) ?? 0n);
    if (verdef != null && verdefnum) {
      const range = mappedELFFileRangeForVa(image2, verdef);
      let p = range?.start ?? null;
      for (let i = 0; p != null && i < Math.min(verdefnum, 65536) && !budget.stopped; i++) {
        if (!budget.step(1, "DT_VERDEF decode")) break;
        if (p + 20 > range.end) {
          partial(image2, "DT_VERDEF crosses a file-backed PT_LOAD boundary");
          break;
        }
        if (!budget.claimInput(20, "DT_VERDEF")) break;
        const ndx = r.u16(p + 4) & 32767, aux = r.u32(p + 12), next = r.u32(p + 16), ap = p + aux;
        if (ap < p || ap + 8 > range.end) {
          partial(image2, "DT_VERDEF auxiliary entry crosses a file-backed PT_LOAD boundary");
          break;
        }
        if (!budget.claimInput(8, "DT_VERDEF auxiliary")) break;
        const name = stringAt(BigInt(r.u32(ap)));
        if (name) {
          if (!budget.claimOutput(1, 96, "DT_VERDEF names")) break;
          names.set(ndx, { name, definition: true, library: null });
        }
        if (!next) break;
        if (next < 20 || p + next <= p || p + next > range.end) {
          partial(image2, "DT_VERDEF next pointer leaves its mapped table");
          break;
        }
        p += next;
      }
    }
    const verneed = one(tags, DT_VERNEED), verneednum = safe(one(tags, DT_VERNEEDNUM) ?? 0n);
    if (verneed != null && verneednum && !budget.stopped) {
      const range = mappedELFFileRangeForVa(image2, verneed);
      let p = range?.start ?? null;
      for (let i = 0; p != null && i < Math.min(verneednum, 65536) && !budget.stopped; i++) {
        if (!budget.step(1, "DT_VERNEED decode")) break;
        if (p + 16 > range.end) {
          partial(image2, "DT_VERNEED crosses a file-backed PT_LOAD boundary");
          break;
        }
        if (!budget.claimInput(16, "DT_VERNEED")) break;
        const cnt = r.u16(p + 2), file2 = stringAt(BigInt(r.u32(p + 4))), aux = r.u32(p + 8), next = r.u32(p + 12);
        let ap = p + aux;
        if (ap < p || ap > range.end) {
          partial(image2, "DT_VERNEED auxiliary pointer leaves its mapped table");
          break;
        }
        for (let j = 0; j < cnt && j < 65536 && !budget.stopped; j++) {
          if (!budget.step(1, "DT_VERNEED auxiliary decode")) break;
          if (ap + 16 > range.end) {
            partial(image2, "DT_VERNEED auxiliary entry crosses a file-backed PT_LOAD boundary");
            break;
          }
          if (!budget.claimInput(16, "DT_VERNEED auxiliary")) break;
          const other = r.u16(ap + 6) & 32767, name = stringAt(BigInt(r.u32(ap + 8))), anext = r.u32(ap + 12);
          if (name) {
            if (!budget.claimOutput(1, 112, "DT_VERNEED names")) break;
            names.set(other, { name, definition: false, library: file2 || null });
          }
          if (!anext) break;
          if (anext < 16 || ap + anext <= ap || ap + anext > range.end) {
            partial(image2, "DT_VERNEED auxiliary next pointer leaves its mapped table");
            break;
          }
          ap += anext;
        }
        if (!next) break;
        if (next < 16 || p + next <= p || p + next > range.end) {
          partial(image2, "DT_VERNEED next pointer leaves its mapped table");
          break;
        }
        p += next;
      }
    }
    for (let i = 0; i < count && !budget.stopped; i++) {
      if (!budget.step(1, "DT_VERSYM decode")) break;
      const raw = r.u16(voff + i * 2), index = raw & 32767;
      if (index <= 1) continue;
      if (!budget.claimOutput(1, 96, "DT_VERSYM entries")) break;
      const named = names.get(index);
      out.set(i, { index, hidden: !!(raw & 32768), name: named?.name || null, library: named?.library || null, definition: named?.definition ?? null });
    }
    image2.metadata.symbolVersions = { entries: out.size, named: [...out.values()].filter((v) => v.name).length, complete: !budget.stopped && !image2.metadata.programDynamicPartial };
    return out;
  }

  // js/binary/elf-dynamic.js
  var PT_DYNAMIC = 2;
  var DT_NULL = 0n;
  var DT_NEEDED = 1n;
  var DT_PLTRELSZ = 2n;
  var DT_HASH = 4n;
  var DT_STRTAB = 5n;
  var DT_SYMTAB = 6n;
  var DT_RELA = 7n;
  var DT_RELASZ = 8n;
  var DT_RELAENT = 9n;
  var DT_STRSZ = 10n;
  var DT_SYMENT = 11n;
  var DT_SONAME = 14n;
  var DT_REL = 17n;
  var DT_RELSZ = 18n;
  var DT_RELENT = 19n;
  var DT_PLTREL = 20n;
  var DT_JMPREL = 23n;
  var DT_GNU_HASH = 0x6ffffef5n;
  function parseProgramDynamic(r, programHeaders, image2, bits, opts = {}) {
    const dyn = (programHeaders || []).find((p) => p.type === PT_DYNAMIC);
    if (!dyn || dyn.filesz <= 0n) return { parsed: false };
    const start = toSafeNumber(dyn.offset);
    const size = toSafeNumber(dyn.filesz);
    if (start == null || size == null || start < 0 || start + size > r.length) {
      image2.warnings.push("PT_DYNAMIC is outside the file");
      return { parsed: false };
    }
    const entSize = bits === 64 ? 16 : 8;
    const tags = /* @__PURE__ */ new Map();
    const ordered = [];
    for (let p = start, guard = 0; p + entSize <= start + size && guard < 1e6; p += entSize, guard++) {
      const tag = bits === 64 ? r.i64(p) : BigInt(r.i32(p));
      const value = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 4));
      if (tag === DT_NULL) break;
      if (!tags.has(tag)) tags.set(tag, []);
      tags.get(tag).push(value);
      ordered.push({ tag, value });
    }
    const one2 = (tag) => tags.get(tag)?.[0] ?? null;
    const strtab = one2(DT_STRTAB);
    const strsz = one2(DT_STRSZ);
    const symtab = one2(DT_SYMTAB);
    const defaultSyment = BigInt(bits === 64 ? 24 : 16);
    const syment = one2(DT_SYMENT) ?? defaultSyment;
    const symentValid = syment >= defaultSyment;
    if (!symentValid) markDynamicPartial(image2, `DT_SYMENT ${syment} is smaller than ${defaultSyment}`);
    const strSize = strsz == null ? 0 : toSafeNumber(strsz);
    const strSpan = strtab == null || strSize == null ? null : mappedELFFileSpanForVa(image2, strtab, strSize);
    if (strtab != null && strSize > 0 && !strSpan) markDynamicPartial(image2, "DT_STRTAB/DT_STRSZ crosses a file-backed PT_LOAD boundary");
    const strOff = strSpan?.start ?? null;
    const stringAt = (offset) => {
      if (strOff == null || strSize == null || !strSpan) return "";
      const n = Number(offset);
      if (!Number.isSafeInteger(n) || n < 0 || n >= strSize || strOff + n >= strSpan.spanEnd) return "";
      return r.cstring(strOff + n, Math.min(strSize - n, strSpan.spanEnd - strOff - n, 1 << 20));
    };
    for (const needed of tags.get(DT_NEEDED) || []) {
      const name = stringAt(needed);
      if (name) image2.libraries.push(name);
    }
    const soname = one2(DT_SONAME);
    if (soname != null) {
      const name = stringAt(soname);
      if (name) image2.metadata.soname = name;
    }
    const relocationBudget = createRelocationBudget({
      onLimit(message) {
        markDynamicPartial(image2, `relocation decode budget exceeded: ${message}`);
      }
    });
    const relocs = collectDynamicRelocations(r, tags, image2, bits, relocationBudget);
    if (!relocationBudget.stopped) collectRelrRelocations(r, tags, image2, bits, { budget: relocationBudget, out: relocs });
    if (!relocationBudget.stopped) collectAndroidPackedRelocations(r, tags, image2, bits, { budget: relocationBudget, out: relocs });
    image2.metadata.programDynamicRelocationBudget = relocationBudget.snapshot(relocs.length);
    const symbolBudget = createDynamicSymbolBudget({
      limits: opts.dynamicSymbolLimits || {},
      onLimit(message) {
        markDynamicPartial(image2, `dynamic symbol decode budget exceeded: ${message}`);
      }
    });
    let declaredSymbolCount = 0;
    let symbolCountSource = "none";
    if (symtab != null && symentValid) {
      declaredSymbolCount = symbolCountFromHash(r, one2(DT_HASH), image2);
      if (declaredSymbolCount) symbolCountSource = "sysv-hash";
      if (!declaredSymbolCount) {
        declaredSymbolCount = symbolCountFromGnuHash(r, one2(DT_GNU_HASH), image2, bits);
        if (declaredSymbolCount) symbolCountSource = "gnu-hash";
      }
      if (!declaredSymbolCount) {
        declaredSymbolCount = symbolCountFromRelocations(relocs);
        if (declaredSymbolCount) symbolCountSource = "relocations";
      }
      if (!declaredSymbolCount) {
        declaredSymbolCount = symbolCountFromLayout(symtab, strtab, syment, image2, r);
        if (declaredSymbolCount) {
          symbolCountSource = "layout-heuristic";
          markExtendedPartial(image2, "dynamic symbol count was inferred from bounded SYMTAB/STRTAB layout");
        }
      }
    }
    const symbolFileCapacity = symtab != null && symentValid ? dynamicSymbolFileCapacity(r, image2, tags, symtab, syment) : 0;
    let symbolCount = Math.min(declaredSymbolCount, symbolFileCapacity, symbolBudget.limits.maxSymbolRecords);
    if (declaredSymbolCount > symbolFileCapacity) {
      markDynamicPartial(image2, `dynamic symbol count ${declaredSymbolCount} exceeds file-backed SYMTAB capacity ${symbolFileCapacity}; clamped`);
    }
    if (declaredSymbolCount > symbolBudget.limits.maxSymbolRecords) {
      markDynamicPartial(image2, `dynamic symbol count ${declaredSymbolCount} exceeds symbol record limit ${symbolBudget.limits.maxSymbolRecords}; clamped`);
    }
    const versions = parseDynamicSymbolVersions(r, tags, image2, symbolCount, stringAt, { budget: symbolBudget });
    let symbols = [];
    if (!symbolBudget.stopped && opts.symbols !== false && symtab != null && symbolCount > 0) {
      symbols = parseDynamicSymbols(r, image2, bits, symtab, syment, symbolCount, stringAt, versions, symbolBudget);
    } else if (symtab != null && symbolCount > 0) {
      symbols = dynamicSymbolsFromImage(image2, symbolCount);
    }
    applyVersionMetadata(image2, versions, symbolBudget);
    image2.metadata.programDynamicSymbolBudget = symbolBudget.snapshot();
    if (opts.relocations !== false) attachDynamicRelocations(image2, relocs, symbols);
    image2.metadata.programDynamic = {
      entries: ordered.length,
      symbols: symbols.length,
      symbolsExpected: symbolCount,
      symbolsDeclared: declaredSymbolCount,
      symbolFileCapacity,
      symbolCountSource,
      relocations: relocs.length,
      sectionless: image2.sections.length === 0,
      hasSysvHash: one2(DT_HASH) != null,
      hasGnuHash: one2(DT_GNU_HASH) != null
    };
    return { parsed: true, tags, symbols: symbols.length, relocations: relocs.length };
  }
  function parseDynamicSymbols(r, image2, bits, symtabVa, syment, count, stringAt, versions = /* @__PURE__ */ new Map(), budget = null) {
    const ent = toSafeNumber(syment);
    if (ent == null || ent <= 0) return [];
    const requested = count * ent;
    const span = Number.isSafeInteger(requested) ? mappedELFFileSpanForVa(image2, symtabVa, requested) : null;
    if (!span) {
      markDynamicPartial(image2, "DT_SYMTAB records cross a file-backed PT_LOAD boundary");
      return [];
    }
    const off = span.start;
    const max = count;
    if (budget && !budget.claimInput(max * ent, "DT_SYMTAB")) return [];
    const out = [];
    for (let i = 0; i < max; i++) {
      if (budget && !budget.step(1, "DT_SYMTAB decode")) break;
      const p = off + i * ent;
      let nameOff, info, other, shndx, value, size;
      if (bits === 64) {
        if (p + 24 > r.length) break;
        nameOff = r.u32(p);
        info = r.u8(p + 4);
        other = r.u8(p + 5);
        shndx = r.u16(p + 6);
        value = r.u64(p + 8);
        size = r.u64(p + 16);
      } else {
        if (p + 16 > r.length) break;
        nameOff = r.u32(p);
        value = BigInt(r.u32(p + 4));
        size = BigInt(r.u32(p + 8));
        info = r.u8(p + 12);
        other = r.u8(p + 13);
        shndx = r.u16(p + 14);
      }
      if (budget && !budget.claimOutput(1, 224, "DT_SYMTAB symbols")) break;
      const name = stringAt(BigInt(nameOff));
      const bind = info >>> 4;
      const type = info & 15;
      const defined = shndx !== 0;
      const binding = bind === 0 ? "local" : bind === 1 ? "global" : bind === 2 ? "weak" : `bind-${bind}`;
      const kind = type === 2 ? "function" : type === 1 ? "object" : type === 3 ? "section" : type === 6 ? "tls" : `type-${type}`;
      const ver = versions.get(i) || null;
      const sym = { name, address: value, size, kind, binding, defined, sectionIndex: shndx, visibility: other & 3, source: "PT_DYNAMIC", index: i, tableIndex: -1, versionIndex: ver?.index ?? null, version: ver?.name ?? null, versionHidden: ver?.hidden ?? false, versionLibrary: ver?.library ?? null };
      out.push(sym);
      if (!name) continue;
      image2.symbols.push(sym);
      if (!defined && (bind === 1 || bind === 2)) {
        if (budget && !budget.claimOutput(1, 160, "PT_DYNAMIC imports")) break;
        image2.imports.push({ name, library: null, ordinal: null, weak: bind === 2, version: ver?.name ?? null, versionLibrary: ver?.library ?? null, versionIndex: ver?.index ?? null, symbolIndex: i, source: "PT_DYNAMIC", sites: [] });
      }
      if (defined && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) {
        if (budget && !budget.claimOutput(1, 144, "PT_DYNAMIC exports")) break;
        image2.exports.push({ name, address: value, kind, version: ver?.name ?? null, versionIndex: ver?.index ?? null, symbolIndex: i, source: "PT_DYNAMIC" });
      }
      if (defined && type === 2 && value !== 0n) {
        if (budget && !budget.claimOutput(1, 128, "PT_DYNAMIC function seeds")) break;
        const owner = (() => {
          const start = value, extent = size || 0n;
          const section = typeof image2.sectionAt === "function" ? image2.sectionAt(start) : null;
          if (section?.perms?.execute && (extent === 0n || extent <= section.address + section.size - start)) return section;
          const segment = typeof image2.segmentAt === "function" ? image2.segmentAt(start) : null;
          if (segment?.perms?.execute && (extent === 0n || extent <= segment.address + segment.size - start)) return segment;
          return null;
        })();
        if (owner) image2.functions.push(functionSeed(value, {
          size: size || null,
          name,
          source: "symbol",
          confidence: 0.995,
          exactFunctionStart: true,
          functionStartEvidence: "ELF PT_DYNAMIC STT_FUNC in validated executable mapping and extent"
        }));
        else markDynamicPartial(image2, `ignored PT_DYNAMIC STT_FUNC ${name} outside executable mapping/extent`);
      }
    }
    return out;
  }
  function applyVersionMetadata(image2, versions, budget = null) {
    if (!versions?.size || budget?.stopped) return;
    const importByIndex = /* @__PURE__ */ new Map();
    const exportByIndex = /* @__PURE__ */ new Map();
    for (const imp of image2.imports) {
      if (imp.symbolIndex == null) continue;
      if (budget && (!budget.step(1, "version import index") || !budget.claimOutput(1, 48, "version import index"))) return;
      if (!importByIndex.has(imp.symbolIndex)) importByIndex.set(imp.symbolIndex, imp);
    }
    for (const ex of image2.exports) {
      if (ex.symbolIndex == null) continue;
      if (budget && (!budget.step(1, "version export index") || !budget.claimOutput(1, 48, "version export index"))) return;
      if (!exportByIndex.has(ex.symbolIndex)) exportByIndex.set(ex.symbolIndex, ex);
    }
    for (const sym of image2.symbols) {
      if (budget && !budget.step(1, "version metadata apply")) return;
      if (sym.source !== "dynsym" && sym.source !== "PT_DYNAMIC") continue;
      const ver = versions.get(sym.index);
      if (!ver) continue;
      sym.versionIndex = ver.index;
      sym.version = ver.name;
      sym.versionHidden = ver.hidden;
      sym.versionLibrary = ver.library;
      if (!sym.defined && sym.name) {
        const imp = importByIndex.get(sym.index);
        if (imp && imp.name === sym.name && imp.version == null) {
          imp.version = ver.name;
          imp.versionLibrary = ver.library;
          imp.versionIndex = ver.index;
        }
      } else if (sym.defined && sym.name) {
        const ex = exportByIndex.get(sym.index);
        if (ex && ex.name === sym.name && ex.address === sym.address && ex.version == null) {
          ex.version = ver.name;
          ex.versionIndex = ver.index;
        }
      }
    }
  }
  function collectDynamicRelocations(r, tags, image2, bits, budget) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const one2 = (tag) => tags.get(tag)?.[0] ?? null;
    const addTable = (va, size, ent, rela, source2) => {
      if (budget.stopped || va == null || size == null || size <= 0n) return;
      const n = toSafeNumber(size);
      const minimum = BigInt(bits === 64 ? rela ? 24 : 16 : rela ? 12 : 8);
      const requested = ent ?? minimum;
      if (requested < minimum) {
        markDynamicPartial(image2, `${source2} entry size ${requested} is smaller than ${minimum}`);
        return;
      }
      const e = toSafeNumber(requested);
      const span = n == null ? null : mappedELFFileSpanForVa(image2, va, n);
      if (!span || e == null || e <= 0) {
        markDynamicPartial(image2, `${source2} table crosses a file-backed PT_LOAD boundary`);
        return;
      }
      const off = span.start;
      if (!budget.claimInput(n, source2)) return;
      const count = Math.floor(n / e);
      for (let i = 0; i < count && !budget.stopped; i++) {
        if (!budget.step()) break;
        const q = off + i * e;
        let address, addend = null, symIndex, type;
        if (bits === 64) {
          address = r.u64(q);
          const info = r.u64(q + 8);
          symIndex = Number(info >> 32n);
          type = Number(info & 0xffffffffn);
          if (rela) addend = r.i64(q + 16);
        } else {
          address = BigInt(r.u32(q));
          const raw = r.u32(q + 4);
          symIndex = raw >>> 8;
          type = raw & 255;
          if (rela) addend = BigInt(r.i32(q + 8));
        }
        const key = `${address}:${symIndex}:${type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!budget.push(out, { address, symIndex, type, addend, source: source2 }, source2)) break;
      }
    };
    addTable(one2(DT_RELA), one2(DT_RELASZ), one2(DT_RELAENT), true, "PT_DYNAMIC-RELA");
    addTable(one2(DT_REL), one2(DT_RELSZ), one2(DT_RELENT), false, "PT_DYNAMIC-REL");
    const jmprel = one2(DT_JMPREL), pltsz = one2(DT_PLTRELSZ), pltrel = one2(DT_PLTREL);
    if (!budget.stopped && jmprel != null && pltsz != null) {
      if (pltrel === DT_RELA) addTable(jmprel, pltsz, one2(DT_RELAENT), true, "PT_DYNAMIC-JMPREL-RELA");
      else if (pltrel === DT_REL) addTable(jmprel, pltsz, one2(DT_RELENT), false, "PT_DYNAMIC-JMPREL-REL");
      else markDynamicPartial(image2, `DT_PLTREL has unsupported value ${pltrel == null ? "<missing>" : pltrel}; JMPREL was not decoded`);
    }
    return out;
  }
  function attachDynamicRelocations(image2, relocs, symbols) {
    const byIndex = new Map((symbols || []).map((s) => [s.index, s]));
    const importKey = (name, version, library) => [name || "", version || "", library || ""].join("\0");
    const importByName = new Map(image2.imports.filter((x) => x.name).map((x) => [importKey(x.name, x.version, x.versionLibrary), x]));
    for (const rel of relocs) {
      const sym = byIndex.get(rel.symIndex) || null;
      const item = {
        address: rel.address,
        fileOffset: image2.addressToOffset(rel.address),
        type: rel.type,
        symbol: sym?.name || null,
        symbolIndex: rel.symIndex,
        addend: rel.addend,
        section: null,
        source: rel.source
      };
      image2.relocations.push(item);
      if (sym && !sym.defined && sym.name) {
        const key = importKey(sym.name, sym.version, sym.versionLibrary);
        let imp = importByName.get(key);
        if (!imp) {
          imp = { name: sym.name, library: null, ordinal: null, weak: sym.binding === "weak", version: sym.version ?? null, versionLibrary: sym.versionLibrary ?? null, versionIndex: sym.versionIndex ?? null, symbolIndex: sym.index, source: "PT_DYNAMIC", sites: [] };
          image2.imports.push(imp);
          importByName.set(key, imp);
        }
        imp.sites.push({ address: rel.address, offset: item.fileOffset, kind: "relocation", type: rel.type });
      }
    }
  }
  function dynamicSymbolsFromImage(image2, limit = Number.MAX_SAFE_INTEGER) {
    const out = [];
    for (const s of image2.symbols) {
      if (s.source !== "dynsym" && s.source !== "PT_DYNAMIC") continue;
      if (out.length >= limit) break;
      if (s.index == null) s.index = out.length;
      out.push(s);
    }
    return out;
  }
  function dynamicSymbolFileCapacity(r, image2, tags, symtabVa, syment) {
    const range = mappedELFFileRangeForVa(image2, symtabVa), ent = toSafeNumber(syment);
    if (!range || ent == null || ent <= 0) return 0;
    let end = range.end;
    const pointerTags = [4n, 5n, 7n, 17n, 23n, 36n, 0x6000000fn, 0x60000011n, 0x6ffffef5n, 0x6ffffff0n, 0x6ffffffcn, 0x6ffffffen];
    for (const tag of pointerTags) for (const va of tags.get(tag) || []) {
      if (va === symtabVa) continue;
      const candidate = mappedELFFileRangeForVa(image2, va);
      if (candidate && candidate.segment === range.segment && candidate.start > range.start && candidate.start < end) end = candidate.start;
    }
    return Math.max(0, Math.floor((end - range.start) / ent));
  }
  function symbolCountFromHash(r, hashVa, image2) {
    if (hashVa == null) return 0;
    const range = mappedELFFileRangeForVa(image2, hashVa);
    if (!range || range.start + 8 > range.end) return 0;
    const nbucket = r.u32(range.start), nchain = r.u32(range.start + 4);
    if (!nchain || nchain > 1e7) return 0;
    const bytes = 8n + BigInt(nbucket + nchain) * 4n;
    if (bytes > BigInt(range.end - range.start)) {
      markDynamicPartial(image2, "DT_HASH table crosses a file-backed PT_LOAD boundary");
      return 0;
    }
    return nchain;
  }
  function symbolCountFromGnuHash(r, hashVa, image2, bits) {
    if (hashVa == null) return 0;
    const range = mappedELFFileRangeForVa(image2, hashVa);
    if (!range || range.start + 16 > range.end) return 0;
    const off = range.start;
    const nbuckets = r.u32(off), symOffset = r.u32(off + 4), bloomSize = r.u32(off + 8);
    if (!nbuckets || nbuckets > 1e7 || bloomSize > 1e7) return 0;
    const word2 = bits === 64 ? 8 : 4;
    const bucketsOff = off + 16 + bloomSize * word2, chainsOff = bucketsOff + nbuckets * 4;
    if (!Number.isSafeInteger(bucketsOff) || !Number.isSafeInteger(chainsOff) || chainsOff > range.end) {
      markDynamicPartial(image2, "DT_GNU_HASH header/buckets cross a file-backed PT_LOAD boundary");
      return 0;
    }
    let max = symOffset, remainingSteps = Math.min(1e7, Math.max(4096, nbuckets * 64));
    for (let i = 0; i < nbuckets; i++) {
      const bucket = r.u32(bucketsOff + i * 4);
      if (!bucket || bucket < symOffset) continue;
      let idx = bucket, p = chainsOff + (idx - symOffset) * 4;
      for (; p + 4 <= range.end; idx++, p += 4) {
        if (--remainingSteps < 0) {
          markDynamicPartial(image2, "GNU hash chain traversal exceeded the global budget");
          return 0;
        }
        const chain = r.u32(p);
        if (idx > max) max = idx;
        if (chain & 1) break;
      }
      if (p + 4 > range.end) {
        markDynamicPartial(image2, "DT_GNU_HASH chain crosses a file-backed PT_LOAD boundary");
        return 0;
      }
    }
    return max >= symOffset ? max + 1 : 0;
  }
  function symbolCountFromRelocations(relocs) {
    let max = -1;
    for (const r of relocs) if (r.symIndex > max) max = r.symIndex;
    return max >= 0 ? max + 1 : 0;
  }
  function symbolCountFromLayout(symtab, strtab, syment, image2, r) {
    if (strtab == null || strtab <= symtab || syment <= 0n) return 0;
    const delta = strtab - symtab;
    if (delta % syment !== 0n) return 0;
    const n = delta / syment;
    if (n <= 0n || n > 1000000n) return 0;
    const symRange = mappedELFFileRangeForVa(image2, symtab), strRange = mappedELFFileRangeForVa(image2, strtab);
    const symOff = symRange?.start ?? null, strOff = strRange?.start ?? null;
    if (symOff == null || strOff == null || symRange.segment !== strRange.segment || strOff <= symOff || strOff > symRange.end) return 0;
    if (BigInt(strOff - symOff) !== delta) return 0;
    return Number(n);
  }
  function markExtendedPartial(image2, message) {
    image2.metadata.programDynamicPartial = true;
    const list = image2.metadata.programDynamicDiagnostics ||= [];
    if (!list.includes(message)) list.push(message);
    image2.warnings.push("PT_DYNAMIC: " + message);
  }
  function markDynamicPartial(image2, message) {
    image2.metadata.programDynamicPartial = true;
    const diagnostics = image2.metadata.programDynamicDiagnostics ||= [];
    if (!diagnostics.includes(message)) diagnostics.push(message);
    image2.warnings.push(`PT_DYNAMIC: ${message}`);
  }
  function toSafeNumber(v) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }

  // js/binary/elf-budget.js
  var ELF_METADATA_LIMITS = Object.freeze({
    inputBytes: 64 * 1024 * 1024,
    records: 25e4,
    objects: 5e5,
    stringBytes: 16 * 1024 * 1024,
    operations: 2e6,
    estimatedHeapBytes: 96 * 1024 * 1024,
    wallClockMs: 5e3
  });
  function metadataOf2(image2) {
    image2.metadata ||= {};
    return image2.metadata.elfMetadata ||= { complete: true, reasons: [] };
  }
  function markELFMetadataPartial(image2, reason, warning = null) {
    const meta = metadataOf2(image2);
    meta.complete = false;
    if (!meta.reasons.includes(reason)) meta.reasons.push(reason);
    if (warning && !image2.warnings.includes(warning)) image2.warnings.push(warning);
  }
  function createELFMetadataBudget(image2, options = {}) {
    const limits = { ...ELF_METADATA_LIMITS, ...options.limits || options.metadataLimits || {} };
    const signal = options.signal || null;
    const started = Date.now();
    const used = { inputBytes: 0, records: 0, objects: 0, stringBytes: 0, operations: 0, estimatedHeapBytes: 0 };
    const meta = metadataOf2(image2);
    meta.limits = { ...limits };
    meta.used = used;
    let nextTimeCheck = 1024;
    const stop = (reason) => {
      markELFMetadataPartial(image2, `budget:${reason}`, `ELF metadata budget exhausted: ${reason}`);
      return false;
    };
    return {
      limits,
      used,
      signal,
      get stopped() {
        return meta.complete === false && meta.reasons.some((r) => r.startsWith("budget:"));
      },
      get remainingStringBytes() {
        return Math.max(0, limits.stringBytes - used.stringBytes);
      },
      take(cost = {}, reason = "metadata") {
        if (signal?.aborted) return stop("aborted");
        const opCost = Math.max(0, Number(cost.operations || 0));
        if (used.operations + opCost >= nextTimeCheck) {
          nextTimeCheck = used.operations + opCost + 1024;
          if (Date.now() - started > limits.wallClockMs) return stop("wall-clock");
        }
        for (const key of Object.keys(used)) {
          const next = used[key] + Math.max(0, Number(cost[key] || 0));
          if (!Number.isFinite(next) || next > limits[key]) return stop(`${reason}:${key}`);
        }
        for (const key of Object.keys(used)) used[key] += Math.max(0, Number(cost[key] || 0));
        return true;
      },
      partial(reason, warning = null) {
        markELFMetadataPartial(image2, reason, warning);
        return false;
      },
      snapshot() {
        return { complete: meta.complete, reasons: [...meta.reasons], limits: { ...limits }, used: { ...used } };
      }
    };
  }

  // js/binary/elf.js
  var ET_REL = 1;
  var PT_LOAD = 1;
  var PT_GNU_EH_FRAME = 1685382480;
  var PN_XNUM = 65535;
  var SHT_SYMTAB = 2;
  var SHT_STRTAB = 3;
  var SHT_RELA = 4;
  var SHT_DYNAMIC = 6;
  var SHT_DYNSYM = 11;
  var SHT_REL = 9;
  var SHT_SYMTAB_SHNDX = 18;
  var SHN_UNDEF = 0;
  var SHN_LORESERVE = 65280;
  var SHN_ABS = 65521;
  var SHN_COMMON = 65522;
  var SHN_XINDEX = 65535;
  var SHF_WRITE = 0x1n;
  var SHF_ALLOC = 0x2n;
  var SHF_EXECINSTR = 0x4n;
  function parseELF(input, options = {}) {
    const initial = new ByteView(input, { littleEndian: true });
    const bytes = initial.bytes;
    if (initial.length < 16 || initial.u8(0) !== 127 || initial.u8(1) !== 69 || initial.u8(2) !== 76 || initial.u8(3) !== 70) throw new Error("not an ELF file");
    const cls = initial.u8(4);
    const data = initial.u8(5);
    if (cls !== 1 && cls !== 2) throw new Error(`unsupported ELF class ${cls}`);
    if (data !== 1 && data !== 2) throw new Error(`unsupported ELF data encoding ${data}`);
    const bits = cls === 2 ? 64 : 32;
    const littleEndian = data === 1;
    const r = new ByteView(bytes, { littleEndian });
    const h = readHeader(r, bits);
    validateHeaderTableSizes(r, h, bits);
    resolveExtendedProgramHeaderCount(r, h, bits);
    const image2 = new BinaryImage(bytes, {
      format: "elf",
      arch: elfMachineName(h.machine),
      bits,
      endian: littleEndian ? "little" : "big",
      platform: elfOsAbi(r.u8(7)),
      entrypoint: h.entry,
      imageBase: 0n,
      metadata: { type: h.type, machine: h.machine, flags: h.flags, osabi: r.u8(7), abiVersion: r.u8(8), extendedProgramHeaderCount: h.extendedPhnum ?? null }
    });
    const programHeaders = parseProgramHeaders(r, h, image2, bits);
    const rawSections = parseSectionHeaders(r, h, bits, image2);
    nameSections(r, rawSections, h);
    if (h.type === ET_REL) assignRelocatableSectionAddresses(rawSections, image2);
    for (const s of rawSections) {
      image2.addSection({
        name: s.name || `section_${s.index}`,
        segment: null,
        address: h.type === ET_REL ? s.syntheticAddr ?? 0n : s.addr,
        size: s.size,
        fileOffset: s.offset,
        fileSize: s.type === 8 ? 0n : s.size,
        perms: { read: !!(s.flags & SHF_ALLOC), write: !!(s.flags & SHF_WRITE), execute: !!(s.flags & SHF_EXECINSTR) },
        flags: s.flags,
        type: s.type,
        index: s.index,
        source: h.type === ET_REL ? "ET_REL-synthetic-section" : "section-header"
      });
    }
    image2.imageBase = h.type === ET_REL ? 0n : findImageBase(image2);
    if (h.type !== ET_REL && image2.entrypoint && image2.entrypoint !== 0n) image2.functions.push(functionSeed(image2.entrypoint, { source: "entrypoint", confidence: 0.9 }));
    const metadataBudget = createELFMetadataBudget(image2, { signal: options.signal, limits: options.metadataLimits });
    const symbolTables = rawSections.filter((s) => s.type === SHT_SYMTAB || s.type === SHT_DYNSYM);
    for (const s of symbolTables) parseSymbols(r, s, rawSections, image2, bits, h.type, metadataBudget);
    for (const s of rawSections) {
      if (s.type === SHT_REL || s.type === SHT_RELA) parseRelocations(r, s, rawSections, image2, bits, h.type, metadataBudget);
      else if (s.type === SHT_DYNAMIC) parseDynamic(r, s, rawSections, image2, bits, metadataBudget);
    }
    const hasDynsym = rawSections.some((s) => s.type === SHT_DYNSYM);
    const hasRelocations = rawSections.some((s) => s.type === SHT_REL || s.type === SHT_RELA);
    const hasDynamic = rawSections.some((s) => s.type === SHT_DYNAMIC);
    parseProgramDynamic(r, programHeaders, image2, bits, {
      symbols: !hasDynsym,
      relocations: !hasRelocations,
      sectionDynamicPresent: hasDynamic
    });
    let ehFrameHdr = rawSections.find((s) => s.name === ".eh_frame_hdr") || null;
    if (!ehFrameHdr) {
      const ph = programHeaders.find((item) => item.type === PT_GNU_EH_FRAME && item.filesz > 0n);
      if (ph) ehFrameHdr = { name: "PT_GNU_EH_FRAME", addr: ph.vaddr, offset: ph.offset, size: ph.filesz };
    }
    if (ehFrameHdr) parseEhFrameHeader(r, ehFrameHdr, image2, bits, metadataBudget);
    image2.metadata.elfMetadata = metadataBudget.snapshot();
    return image2.finalize();
  }
  function alignUp(value, alignment) {
    const a = alignment > 0n ? alignment : 1n;
    const rem = value % a;
    return rem === 0n ? value : value + (a - rem);
  }
  function assignRelocatableSectionAddresses(sections, image2) {
    let cursor = 0x100000000n;
    const MAX_ALIGN = 0x1000000n;
    for (const sec of sections) {
      if (sec.index === 0 || sec.size <= 0n) {
        sec.syntheticAddr = 0n;
        continue;
      }
      const requested = sec.addralign > 0n ? sec.addralign : 1n;
      const alignment = requested > MAX_ALIGN ? MAX_ALIGN : requested;
      cursor = alignUp(cursor, alignment);
      sec.syntheticAddr = cursor;
      cursor += sec.size > 0n ? sec.size : 1n;
    }
    image2.metadata.relocatableAddressModel = {
      kind: "synthetic-section-layout",
      base: "0x100000000",
      sections: sections.filter((s) => s.syntheticAddr).length
    };
  }
  function normalSectionIndex(index, sections) {
    return Number.isInteger(index) && index > 0 && index < sections.length && index < SHN_LORESERVE;
  }
  function symbolAddressForELF(elfType, value, sectionIndex, sections) {
    if (elfType !== ET_REL) return value;
    if (sectionIndex === SHN_ABS) return value;
    if (sectionIndex === SHN_COMMON || sectionIndex === SHN_UNDEF) return null;
    if (!normalSectionIndex(sectionIndex, sections)) return null;
    const sec = sections[sectionIndex];
    if (value > sec.size) return null;
    return (sec.syntheticAddr ?? 0n) + value;
  }
  function readHeader(r, bits) {
    if (bits === 64) {
      r.check(0, 64);
      return {
        type: r.u16(16),
        machine: r.u16(18),
        version: r.u32(20),
        entry: r.u64(24),
        phoff: r.u64(32),
        shoff: r.u64(40),
        flags: r.u32(48),
        ehsize: r.u16(52),
        phentsize: r.u16(54),
        phnum: r.u16(56),
        shentsize: r.u16(58),
        shnum: r.u16(60),
        shstrndx: r.u16(62)
      };
    }
    r.check(0, 52);
    return {
      type: r.u16(16),
      machine: r.u16(18),
      version: r.u32(20),
      entry: BigInt(r.u32(24)),
      phoff: BigInt(r.u32(28)),
      shoff: BigInt(r.u32(32)),
      flags: r.u32(36),
      ehsize: r.u16(40),
      phentsize: r.u16(42),
      phnum: r.u16(44),
      shentsize: r.u16(46),
      shnum: r.u16(48),
      shstrndx: r.u16(50)
    };
  }
  function validateHeaderTableSizes(r, h, bits) {
    const minHeader = bits === 64 ? 64 : 52;
    const minProgram = bits === 64 ? 56 : 32;
    const minSection = bits === 64 ? 64 : 40;
    if (h.ehsize < minHeader) throw new Error(`ELF e_ehsize ${h.ehsize} is smaller than ${minHeader}`);
    if (h.phoff !== 0n && h.phnum !== 0 && h.phentsize < minProgram) throw new Error(`ELF e_phentsize ${h.phentsize} is smaller than ${minProgram}`);
    if (h.shoff !== 0n && h.shentsize < minSection) throw new Error(`ELF e_shentsize ${h.shentsize} is smaller than ${minSection}`);
    if (h.phnum === PN_XNUM && h.shoff === 0n) throw new Error("ELF PN_XNUM requires section header 0");
    void r;
  }
  function resolveExtendedProgramHeaderCount(r, h, bits) {
    if (h.phnum !== PN_XNUM) return;
    const off = safeOffset(h.shoff);
    const minSection = bits === 64 ? 64 : 40;
    if (off == null || off <= 0 || off + minSection > r.length) throw new Error("ELF PN_XNUM section header 0 is truncated");
    const actual = r.u32(off + (bits === 64 ? 44 : 28));
    if (actual > 1e6) throw new Error(`invalid ELF extended program header count ${actual}`);
    h.extendedPhnum = actual;
    h.phnum = actual;
  }
  function parseProgramHeaders(r, h, image2, bits) {
    const out = [];
    const off = safeOffset(h.phoff);
    if (off == null) {
      image2.warnings.push("ELF program header offset is not safely representable");
      return out;
    }
    if (!h.phnum || !h.phentsize || off <= 0) return out;
    if (off + h.phnum * h.phentsize > r.length) {
      image2.warnings.push("ELF program header table is truncated");
      return out;
    }
    for (let i = 0; i < h.phnum; i++) {
      const p = off + i * h.phentsize;
      let ph;
      if (bits === 64) {
        ph = { type: r.u32(p), flags: r.u32(p + 4), offset: r.u64(p + 8), vaddr: r.u64(p + 16), filesz: r.u64(p + 32), memsz: r.u64(p + 40), align: r.u64(p + 48) };
      } else {
        ph = { type: r.u32(p), offset: BigInt(r.u32(p + 4)), vaddr: BigInt(r.u32(p + 8)), filesz: BigInt(r.u32(p + 16)), memsz: BigInt(r.u32(p + 20)), flags: r.u32(p + 24), align: BigInt(r.u32(p + 28)) };
      }
      if (ph.type === PT_LOAD) {
        const fileLength = BigInt(r.length);
        const invalidSize = ph.filesz > ph.memsz;
        const invalidRange = ph.offset > fileLength || ph.filesz > fileLength - ph.offset;
        if (invalidSize || invalidRange) {
          image2.warnings.push(`invalid ELF PT_LOAD ${i}: ${invalidSize ? "p_filesz > p_memsz" : "file range exceeds input"}`);
          continue;
        }
      }
      out.push(ph);
      if (ph.type === PT_LOAD) {
        image2.addSegment({
          name: `LOAD${i}`,
          address: ph.vaddr,
          size: ph.memsz,
          fileOffset: ph.offset,
          fileSize: ph.filesz,
          perms: { read: !!(ph.flags & 4), write: !!(ph.flags & 2), execute: !!(ph.flags & 1) },
          flags: ph.flags,
          source: "PT_LOAD"
        });
      }
    }
    return out;
  }
  function parseSectionHeaders(r, h, bits, image2) {
    const off = safeOffset(h.shoff);
    let count = h.shnum;
    if (off == null) {
      image2.warnings.push("ELF section header offset is not safely representable");
      return [];
    }
    if (!off || !h.shentsize) return [];
    if (off + h.shentsize > r.length) {
      image2.warnings.push("ELF section header table is truncated");
      return [];
    }
    if (count === 0) count = bits === 64 ? Number(r.u64(off + 32)) : r.u32(off + 20);
    if (count > 1e5 || off + count * h.shentsize > r.length) {
      image2.warnings.push(`invalid ELF section count ${count}`);
      return [];
    }
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = off + i * h.shentsize;
      if (bits === 64) {
        out.push({ index: i, nameOffset: r.u32(p), type: r.u32(p + 4), flags: r.u64(p + 8), addr: r.u64(p + 16), offset: r.u64(p + 24), size: r.u64(p + 32), link: r.u32(p + 40), info: r.u32(p + 44), addralign: r.u64(p + 48), entsize: r.u64(p + 56), name: "" });
      } else {
        out.push({ index: i, nameOffset: r.u32(p), type: r.u32(p + 4), flags: BigInt(r.u32(p + 8)), addr: BigInt(r.u32(p + 12)), offset: BigInt(r.u32(p + 16)), size: BigInt(r.u32(p + 20)), link: r.u32(p + 24), info: r.u32(p + 28), addralign: BigInt(r.u32(p + 32)), entsize: BigInt(r.u32(p + 36)), name: "" });
      }
    }
    if (h.shstrndx === 65535 && out[0]) h.shstrndx = out[0].link;
    return out;
  }
  function nameSections(r, sections, h) {
    const str = sections[h.shstrndx];
    if (!str || str.type !== SHT_STRTAB || str.offset + str.size > BigInt(r.length)) return;
    for (const s of sections) {
      if (BigInt(s.nameOffset) >= str.size) continue;
      try {
        s.name = r.cstring(Number(str.offset) + s.nameOffset, Number(str.size) - s.nameOffset);
      } catch (error) {
        if (error?.code === "BINARY_SOURCE_RANGE_MISSING") throw error;
        s.name = "";
      }
    }
  }
  function parseSymbols(r, table, sections, image2, bits, elfType, budget) {
    const str = sections[table.link];
    if (!str || str.type !== SHT_STRTAB || !table.entsize) return;
    const minEnt = BigInt(bits === 64 ? 24 : 16);
    if (table.entsize < minEnt) {
      budget.partial(`symbols:${table.index}:entry-size`, `ELF symbol table ${table.index} entry size ${table.entsize} is smaller than ${minEnt}`);
      return;
    }
    const tableStart = safeOffset(table.offset), ent = safeOffset(table.entsize);
    const strStart = safeOffset(str.offset), strBytes = safeOffset(str.size);
    if (tableStart == null || ent == null || strStart == null || strBytes == null || tableStart > r.length || strStart > r.length || strBytes > r.length - strStart) {
      budget.partial(`symbols:${table.index}:file-span`, `ELF symbol/string table ${table.index} exceeds the file`);
      return;
    }
    const declaredBig = table.size / table.entsize;
    const fileCapacity = Math.floor((r.length - tableStart) / ent);
    const declared = declaredBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(declaredBig);
    const count = Math.min(declared, fileCapacity);
    if (declaredBig > BigInt(fileCapacity)) budget.partial(`symbols:${table.index}:truncated`, `ELF symbol table ${table.index} exceeds its file-backed capacity`);
    const xindex = sections.find((sec) => sec.type === SHT_SYMTAB_SHNDX && sec.link === table.index) || null;
    const xindexValid = !!xindex && (!xindex.entsize || xindex.entsize === 4n) && xindex.offset <= BigInt(r.length) && xindex.size <= BigInt(r.length) - xindex.offset;
    if (xindex && !xindexValid) budget.partial(`symbols:${table.index}:xindex-malformed`, `ELF SHT_SYMTAB_SHNDX for table ${table.index} is malformed`);
    for (let i = 0; i < count; i++) {
      if (!budget.take({ inputBytes: ent, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 224 }, `symbols-${table.index}`)) break;
      const p = tableStart + i * ent;
      let nameOff, info, other, shndx, value, size;
      if (bits === 64) {
        nameOff = r.u32(p);
        info = r.u8(p + 4);
        other = r.u8(p + 5);
        shndx = r.u16(p + 6);
        value = r.u64(p + 8);
        size = r.u64(p + 16);
      } else {
        nameOff = r.u32(p);
        value = BigInt(r.u32(p + 4));
        size = BigInt(r.u32(p + 8));
        info = r.u8(p + 12);
        other = r.u8(p + 13);
        shndx = r.u16(p + 14);
      }
      if (BigInt(nameOff) >= str.size || nameOff >= strBytes) continue;
      const maxName = Math.min(strBytes - nameOff, 1 << 20, Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1));
      const name = r.cstring(strStart + nameOff, maxName);
      if (!name) continue;
      if (!budget.take({ inputBytes: Math.min(maxName, name.length + 1), stringBytes: name.length * 2, estimatedHeapBytes: name.length * 2 + 32 }, "symbol-name")) break;
      const bind = info >>> 4, type = info & 15;
      let resolvedShndx = shndx, sectionIdentityKnown = true;
      if (shndx === SHN_XINDEX) {
        resolvedShndx = null;
        sectionIdentityKnown = false;
        const xoff = xindexValid ? safeOffset(xindex.offset + BigInt(i * 4)) : null;
        if (xoff == null || xoff + 4 > r.length || BigInt((i + 1) * 4) > xindex.size) {
          image2.warnings.push(`ELF symbol ${i} uses SHN_XINDEX without a valid SHT_SYMTAB_SHNDX entry`);
        } else {
          const candidate = r.u32(xoff);
          if (candidate === SHN_UNDEF || candidate === SHN_ABS || candidate === SHN_COMMON || candidate < sections.length) {
            resolvedShndx = candidate;
            sectionIdentityKnown = true;
          } else image2.warnings.push(`ELF symbol ${i} has out-of-range extended section index ${candidate}`);
        }
      }
      const normal = sectionIdentityKnown && normalSectionIndex(resolvedShndx, sections);
      const specialKnown = resolvedShndx === SHN_UNDEF || resolvedShndx === SHN_ABS || resolvedShndx === SHN_COMMON;
      if (sectionIdentityKnown && !normal && !specialKnown) {
        sectionIdentityKnown = false;
        image2.warnings.push(`ELF symbol ${i} uses unsupported reserved section index ${resolvedShndx}`);
      }
      const defined = sectionIdentityKnown ? resolvedShndx !== SHN_UNDEF : null;
      const address = sectionIdentityKnown ? symbolAddressForELF(elfType, value, resolvedShndx, sections) : null;
      const binding = bind === 0 ? "local" : bind === 1 ? "global" : bind === 2 ? "weak" : `bind-${bind}`;
      const kind = type === 2 ? "function" : type === 1 ? "object" : type === 3 ? "section" : type === 6 ? "tls" : `type-${type}`;
      const sym = {
        name,
        address: address ?? 0n,
        originalValue: value,
        size,
        kind,
        binding,
        defined,
        sectionIndex: sectionIdentityKnown ? resolvedShndx : null,
        visibility: other & 3,
        source: table.type === SHT_DYNSYM ? "dynsym" : "symtab",
        index: i,
        tableIndex: table.index,
        sectionRelative: elfType === ET_REL && normal ? { sectionIndex: resolvedShndx, offset: value } : null,
        addressDomain: elfType === ET_REL && normal ? "section-relative-synthetic" : "virtual"
      };
      image2.symbols.push(sym);
      if (defined === false && (bind === 1 || bind === 2)) {
        if (!budget.take({ objects: 1, operations: 1, estimatedHeapBytes: 160 }, "symbol-import")) break;
        image2.imports.push({ name, library: null, ordinal: null, weak: bind === 2, symbolIndex: i, tableIndex: table.index, source: "elf-dynsym", sites: [] });
      }
      if (defined === true && address != null && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) {
        if (!budget.take({ objects: 1, operations: 1, estimatedHeapBytes: 144 }, "symbol-export")) break;
        image2.exports.push({ name, address, kind, symbolIndex: i, tableIndex: table.index, source: sym.source });
      }
      if (defined === true && type === 2 && address != null && address !== 0n) {
        const owner = executableELFRange(image2, address, size || 0n, normal ? resolvedShndx : null);
        if (owner) {
          if (!budget.take({ objects: 1, operations: 1, estimatedHeapBytes: 128 }, "symbol-function")) break;
          image2.functions.push(functionSeed(address, { size: size || null, name, source: "symbol", confidence: 0.995, exactFunctionStart: true, functionStartEvidence: elfType === ET_REL ? "ELF ET_REL STT_FUNC with validated executable section-relative extent" : "ELF STT_FUNC with validated executable section extent" }));
        } else image2.warnings.push(`Ignored ELF STT_FUNC ${name} outside its canonical executable extent`);
      }
    }
  }
  function parseRelocations(r, sec, sections, image2, bits, elfType, budget) {
    if (!sec.entsize) return;
    const minEnt = BigInt(bits === 64 ? sec.type === SHT_RELA ? 24 : 16 : sec.type === SHT_RELA ? 12 : 8);
    if (sec.entsize < minEnt) {
      budget.partial(`relocations:${sec.index}:entry-size`, `ELF relocation section ${sec.index} entry size ${sec.entsize} is smaller than ${minEnt}`);
      return;
    }
    const tableStart = safeOffset(sec.offset), ent = safeOffset(sec.entsize);
    if (tableStart == null || ent == null || tableStart > r.length) {
      budget.partial(`relocations:${sec.index}:file-span`, `ELF relocation section ${sec.index} has an invalid file span`);
      return;
    }
    const declaredBig = sec.size / sec.entsize, fileCapacity = Math.floor((r.length - tableStart) / ent), declared = declaredBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(declaredBig), count = Math.min(declared, fileCapacity);
    if (declaredBig > BigInt(fileCapacity)) budget.partial(`relocations:${sec.index}:truncated`, `ELF relocation section ${sec.index} exceeds its file-backed capacity`);
    const symbols = image2.symbols.filter((x) => x.tableIndex === sec.link);
    if (!budget.take({ objects: symbols.length, operations: symbols.length, estimatedHeapBytes: symbols.length * 48 }, "relocation-symbol-index")) return;
    const byIndex = new Map(symbols.map((x) => [x.index, x]));
    const target = elfType === ET_REL ? sections[sec.info] : null;
    if (elfType === ET_REL && !normalSectionIndex(sec.info, sections)) {
      budget.partial(`relocations:${sec.index}:target-section`, `ELF ET_REL relocation section ${sec.index} has invalid sh_info target section ${sec.info}`);
      return;
    }
    for (let i = 0; i < count; i++) {
      if (!budget.take({ inputBytes: ent, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 144 }, `relocations-${sec.index}`)) break;
      const p = tableStart + i * ent;
      let offset, addend = null, symIndex, type;
      if (bits === 64) {
        offset = r.u64(p);
        const info = r.u64(p + 8);
        symIndex = Number(info >> 32n);
        type = Number(info & 0xffffffffn);
        if (sec.type === SHT_RELA) addend = r.i64(p + 16);
      } else {
        offset = BigInt(r.u32(p));
        const raw = r.u32(p + 4);
        symIndex = raw >>> 8;
        type = raw & 255;
        if (sec.type === SHT_RELA) addend = BigInt(r.i32(p + 8));
      }
      let address = offset, fileOffset = image2.addressToOffset(offset), addressDomain = "virtual";
      if (elfType === ET_REL) {
        if (offset >= target.size) {
          budget.partial(`relocations:${sec.index}:offset-range`, `ELF ET_REL relocation offset ${offset} is outside target section ${target.index}`);
          continue;
        }
        address = (target.syntheticAddr ?? 0n) + offset;
        addressDomain = "section-relative-synthetic";
        fileOffset = target.type === 8 || offset >= target.size ? null : target.offset + offset;
      }
      const sym = byIndex.get(symIndex) || null;
      image2.relocations.push({ address, fileOffset, type, symbol: sym ? sym.name : null, symbolIndex: symIndex, addend, section: sec.name, source: sec.type === SHT_RELA ? "RELA" : "REL", sectionRelative: elfType === ET_REL ? { sectionIndex: sec.info, offset } : null, addressDomain });
      if (sym && sym.defined === false) {
        const imp = image2.imports.find((x) => x.name === sym.name && x.library == null);
        if (imp) {
          if (!budget.take({ objects: 1, operations: 1, estimatedHeapBytes: 96 }, "relocation-import-site")) break;
          imp.sites.push({ address, offset: fileOffset, kind: "relocation", type, sectionRelative: elfType === ET_REL ? { sectionIndex: sec.info, offset } : null });
        }
      }
    }
  }
  function parseDynamic(r, sec, sections, image2, bits, budget) {
    const str = sections[sec.link];
    if (!str || str.type !== SHT_STRTAB) return;
    const ent = Number(sec.entsize || (bits === 64 ? 16n : 8n));
    if (!ent) return;
    const start = safeOffset(sec.offset), strStart = safeOffset(str.offset), strSize = safeOffset(str.size);
    if (start == null || strStart == null || strSize == null || start > r.length || strStart > r.length || strSize > r.length - strStart) {
      budget.partial(`dynamic-section:${sec.index}:span`, `ELF SHT_DYNAMIC/string table exceeds the file`);
      return;
    }
    const fileCapacity = Math.floor((r.length - start) / ent), declared = Math.floor(Number(sec.size) / ent), count = Math.min(declared, fileCapacity);
    if (declared > fileCapacity) budget.partial(`dynamic-section:${sec.index}:truncated`, `ELF SHT_DYNAMIC exceeds its file-backed capacity`);
    for (let i = 0; i < count; i++) {
      if (!budget.take({ inputBytes: ent, records: 1, operations: 1, estimatedHeapBytes: 32 }, "SHT_DYNAMIC")) break;
      const p = start + i * ent, tag = bits === 64 ? r.i64(p) : BigInt(r.i32(p)), val = bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 4));
      if (tag === 0n) break;
      if ((tag === 1n || tag === 14n) && val < str.size) {
        const off = Number(val), max = Math.min(strSize - off, 1 << 20, Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1)), name = r.cstring(strStart + off, max);
        if (name && !budget.take({ inputBytes: Math.min(max, name.length + 1), stringBytes: name.length * 2, estimatedHeapBytes: name.length * 2 + 32 }, "SHT_DYNAMIC-string")) break;
        if (tag === 1n && name) image2.libraries.push(name);
        else if (tag === 14n && name) image2.metadata.soname = name;
      }
    }
  }
  function findImageBase(image2) {
    const loads = image2.segments.filter((s) => s.address != null);
    if (!loads.length) return 0n;
    let base = loads[0].address - loads[0].fileOffset;
    for (const s of loads) {
      const b = s.address - s.fileOffset;
      if (b < base) base = b;
    }
    return base;
  }
  function elfMachineName(m) {
    return { 3: "x86", 8: "mips", 20: "ppc", 21: "ppc64", 40: "arm", 62: "x86_64", 183: "arm64", 243: "riscv" }[m] || `machine-${m}`;
  }
  function elfOsAbi(v) {
    return { 0: "sysv", 1: "hpux", 2: "netbsd", 3: "linux", 6: "solaris", 9: "freebsd", 12: "openbsd" }[v] || `elf-osabi-${v}`;
  }
  function safeOffset(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }

  // js/binary/pe-loader.js
  var PE_METADATA_LIMITS = Object.freeze({
    inputBytes: 64 * 1024 * 1024,
    records: 25e4,
    objects: 5e5,
    stringBytes: 16 * 1024 * 1024,
    operations: 2e6,
    estimatedHeapBytes: 96 * 1024 * 1024,
    wallClockMs: 5e3
  });
  function markPEPartial(image2, reason, warning = null) {
    image2.metadata ||= {};
    image2.metadata.peMetadata ||= { complete: true, reasons: [] };
    image2.metadata.peMetadata.complete = false;
    if (!image2.metadata.peMetadata.reasons.includes(reason)) image2.metadata.peMetadata.reasons.push(reason);
    if (warning && !image2.warnings.includes(warning)) image2.warnings.push(warning);
  }
  function createPEMetadataBudget(image2, options = {}) {
    image2.metadata ||= {};
    const limits = { ...PE_METADATA_LIMITS, ...options.limits || options.metadataLimits || {} };
    const signal = options.signal || null;
    const started = Date.now();
    const used = { inputBytes: 0, records: 0, objects: 0, stringBytes: 0, operations: 0, estimatedHeapBytes: 0 };
    const meta = image2.metadata.peMetadata ||= { complete: true, reasons: [] };
    meta.limits = { ...limits };
    meta.used = used;
    const fail = (reason) => {
      markPEPartial(image2, `budget:${reason}`, `PE metadata budget exhausted: ${reason}`);
      return false;
    };
    const budget = {
      limits,
      used,
      signal,
      get remainingStringBytes() {
        return Math.max(0, limits.stringBytes - used.stringBytes);
      },
      take(cost = {}, reason = "metadata") {
        if (signal?.aborted) return fail("aborted");
        const nextOps = used.operations + (cost.operations || 0);
        if ((nextOps & 1023) === 0 && Date.now() - started > limits.wallClockMs) return fail("wall-clock");
        for (const key of ["inputBytes", "records", "objects", "stringBytes", "operations", "estimatedHeapBytes"]) {
          const next = used[key] + (cost[key] || 0);
          if (!Number.isFinite(next) || next < 0 || next > limits[key]) return fail(`${reason}:${key}`);
        }
        for (const key of Object.keys(used)) used[key] += cost[key] || 0;
        return true;
      },
      partial(reason, warning = null) {
        markPEPartial(image2, reason, warning);
        return false;
      }
    };
    return budget;
  }
  function ensureBudget(image2, budget) {
    return budget || createPEMetadataBudget(image2);
  }
  function mappedFileRangeForRva(image2, rva) {
    if (!Number.isInteger(rva) || rva <= 0) return null;
    const address = image2.imageBase + BigInt(rva);
    const owners = [...image2.sections || [], ...image2.segments || []];
    for (const owner of owners) {
      if (!owner || owner.address == null || owner.fileOffset == null || owner.fileSize == null) continue;
      const fileSize = BigInt(owner.fileSize);
      if (fileSize <= 0n || address < owner.address || address >= owner.address + fileSize) continue;
      const delta = address - owner.address;
      const start = BigInt(owner.fileOffset) + delta;
      const end = BigInt(owner.fileOffset) + fileSize;
      if (start > BigInt(Number.MAX_SAFE_INTEGER) || end > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return { start: Number(start), end: Number(end), owner, address };
    }
    return null;
  }
  function mappedFileSpanForRva(image2, rva, size) {
    if (!Number.isSafeInteger(size) || size < 0) return null;
    if (size === 0) return mappedFileRangeForRva(image2, rva);
    const range = mappedFileRangeForRva(image2, rva);
    if (!range || size > range.end - range.start) return null;
    return { ...range, spanEnd: range.start + size };
  }
  function mappedFileRangeForAddress(image2, address) {
    const a = BigInt(address);
    if (a < image2.imageBase || a - image2.imageBase > 0xffffffffn) return null;
    return mappedFileRangeForRva(image2, Number(a - image2.imageBase));
  }
  function mappedCStringAtRva(r, image2, rva, budget, label) {
    const range = mappedFileRangeForRva(image2, rva);
    if (!range) {
      budget.partial(`${label}:unmapped-string`, `Ignored ${label} string outside a file-backed mapping`);
      return "";
    }
    const maxByStringBudget = Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1);
    const max = Math.min(1 << 16, range.end - range.start, maxByStringBudget);
    if (max <= 0) return "";
    const value = r.cstring(range.start, max);
    const inputBytes = Math.min(max, value.length + 1);
    if (!budget.take({ inputBytes, stringBytes: value.length * 2, operations: 1, estimatedHeapBytes: value.length * 2 + 32 }, `${label}-string`)) return "";
    return value;
  }
  function mappedCStringAtOffset(r, start, end, budget, label) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > r.length) return "";
    const max = Math.min(1 << 16, end - start, Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1));
    const value = r.cstring(start, max);
    if (!budget.take({ inputBytes: Math.min(max, value.length + 1), stringBytes: value.length * 2, operations: 1, estimatedHeapBytes: value.length * 2 + 32 }, `${label}-string`)) return "";
    return value;
  }
  function markImportPartial(image2, message) {
    image2.metadata.peImports ||= { complete: true, truncatedTables: 0 };
    image2.metadata.peImports.complete = false;
    image2.metadata.peImports.truncatedTables++;
    markPEPartial(image2, "imports-partial", message);
  }
  function parseImports(r, dir, image2, sharedBudget = null) {
    if (!dir || !dir.rva || !dir.size) return;
    const budget = ensureBudget(image2, sharedBudget);
    image2.metadata.peImports ||= { complete: true, truncatedTables: 0 };
    const dirRange = mappedFileSpanForRva(image2, dir.rva, dir.size);
    if (!dirRange) {
      markImportPartial(image2, "PE import directory crosses a mapped RVA/file boundary");
      return;
    }
    let off = dirRange.start;
    const end = dirRange.spanEnd;
    const ptrSize = image2.bits === 64 ? 8 : 4;
    let terminatedDescriptors = false;
    for (let guard = 0; guard < 65536 && off + 20 <= end; guard++, off += 20) {
      if (!budget.take({ inputBytes: 20, records: 1, operations: 1, estimatedHeapBytes: 32 }, "import-descriptor")) break;
      const originalFirstThunk = r.u32(off), timeDateStamp = r.u32(off + 4), forwarderChain = r.u32(off + 8);
      const nameRva = r.u32(off + 12), firstThunk = r.u32(off + 16);
      if (!(originalFirstThunk || timeDateStamp || forwarderChain || nameRva || firstThunk)) {
        terminatedDescriptors = true;
        break;
      }
      const library = mappedCStringAtRva(r, image2, nameRva, budget, "PE import library");
      if (library) image2.libraries.push(library);
      const thunkRva = originalFirstThunk || firstThunk;
      const thunkRange = mappedFileRangeForRva(image2, thunkRva), iatRange = mappedFileRangeForRva(image2, firstThunk);
      if (!thunkRange || !iatRange) {
        markImportPartial(image2, `PE import thunk table for ${library || "<unknown>"} is not fully file-backed`);
        continue;
      }
      let terminated = false;
      for (let index = 0; index < 1e5; index++) {
        const thunkOff = thunkRange.start + index * ptrSize, iatOff = iatRange.start + index * ptrSize;
        if (thunkOff + ptrSize > thunkRange.end || iatOff + ptrSize > iatRange.end || thunkOff + ptrSize > r.length || iatOff + ptrSize > r.length) break;
        if (!budget.take({ inputBytes: ptrSize * 2, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 192 }, "import-thunk")) break;
        const raw = image2.bits === 64 ? r.u64(thunkOff) : BigInt(r.u32(thunkOff));
        if (raw === 0n) {
          terminated = true;
          break;
        }
        const ordinalMask = image2.bits === 64 ? 0x8000000000000000n : 0x80000000n;
        let name = null, ordinal = null, hint = null;
        if (raw & ordinalMask) ordinal = Number(raw & 0xffffn);
        else {
          const ibnRaw = raw & (image2.bits === 64 ? 0x7fffffffffffffffn : 0x7fffffffn);
          if (ibnRaw > 0xffffffffn) {
            markImportPartial(image2, `Ignored PE import thunk with out-of-range name RVA for ${library || "<unknown>"}`);
            continue;
          }
          const ibnRva = Number(ibnRaw), ibnRange = mappedFileRangeForRva(image2, ibnRva);
          if (ibnRange && ibnRange.start + 2 < ibnRange.end) {
            hint = r.u16(ibnRange.start);
            name = mappedCStringAtOffset(r, ibnRange.start + 2, ibnRange.end, budget, "PE import name");
          }
          if (!name) {
            markImportPartial(image2, `Ignored malformed PE import thunk for ${library || "<unknown>"}`);
            continue;
          }
        }
        const iatAddress = image2.imageBase + BigInt(firstThunk + index * ptrSize);
        image2.imports.push({ name: name || `#${ordinal}`, library, ordinal, hint, source: "PE-import", sites: [{ address: iatAddress, offset: BigInt(iatOff), kind: "iat" }] });
      }
      if (!terminated) markImportPartial(image2, `PE import thunk table for ${library || "<unknown>"} reached its mapped file boundary without a NUL terminator`);
    }
    if (!terminatedDescriptors && off + 20 > end) markImportPartial(image2, "PE import descriptor table reached its mapped boundary without a zero descriptor");
  }
  function parseExports(r, dir, image2, sharedBudget = null) {
    if (!dir || !dir.rva || dir.size < 40) return;
    const budget = ensureBudget(image2, sharedBudget);
    const header = mappedFileSpanForRva(image2, dir.rva, 40);
    if (!header) {
      budget.partial("exports:unmapped-header", "PE export directory header is not fully file-backed");
      return;
    }
    const off = header.start;
    const nameRva = r.u32(off + 12), baseOrdinal = r.u32(off + 16), numberOfFunctions = r.u32(off + 20), numberOfNames = r.u32(off + 24);
    const addrFunctions = r.u32(off + 28), addrNames = r.u32(off + 32), addrOrdinals = r.u32(off + 36);
    const dllName = mappedCStringAtRva(r, image2, nameRva, budget, "PE export DLL");
    if (dllName) image2.metadata.exportName = dllName;
    const fBytes = numberOfFunctions * 4, nBytes = numberOfNames * 4, oBytes = numberOfNames * 2;
    if (!Number.isSafeInteger(fBytes) || !Number.isSafeInteger(nBytes) || !Number.isSafeInteger(oBytes)) {
      budget.partial("exports:count-overflow", "PE export table count overflows safe span arithmetic");
      return;
    }
    const fr = numberOfFunctions ? mappedFileSpanForRva(image2, addrFunctions, fBytes) : null;
    const nr = numberOfNames ? mappedFileSpanForRva(image2, addrNames, nBytes) : null;
    const or = numberOfNames ? mappedFileSpanForRva(image2, addrOrdinals, oBytes) : null;
    if (numberOfFunctions && !fr) {
      budget.partial("exports:function-array-span", "PE export function RVA array crosses a mapped boundary");
      return;
    }
    if (numberOfNames && (!nr || !or)) {
      budget.partial("exports:name-array-span", "PE export name/ordinal array crosses a mapped boundary");
      return;
    }
    const names = /* @__PURE__ */ new Map();
    for (let i = 0; i < numberOfNames; i++) {
      if (!budget.take({ inputBytes: 6, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 96 }, "export-name-record")) break;
      const nrva = r.u32(nr.start + i * 4), ordIndex = r.u16(or.start + i * 2);
      const name = mappedCStringAtRva(r, image2, nrva, budget, "PE export name");
      if (name) names.set(ordIndex, name);
    }
    const dirStart = dir.rva, dirEnd = dir.rva + dir.size;
    for (let i = 0; i < numberOfFunctions; i++) {
      if (!budget.take({ inputBytes: 4, records: 1, objects: 2, operations: 2, estimatedHeapBytes: 256 }, "export-function-record")) break;
      const frva = r.u32(fr.start + i * 4);
      if (!frva) continue;
      const name = names.get(i) || `#${baseOrdinal + i}`;
      if (frva >= dirStart && frva < dirEnd) {
        const forwarder = mappedCStringAtRva(r, image2, frva, budget, "PE export forwarder");
        image2.exports.push({ name, address: 0n, ordinal: baseOrdinal + i, kind: "forwarder", forwarder: forwarder || null, source: "PE-export" });
        continue;
      }
      const address = image2.imageBase + BigInt(frva);
      image2.exports.push({ name, address, ordinal: baseOrdinal + i, kind: "export", source: "PE-export" });
      const sec = image2.sectionAt(address);
      if (sec && sec.perms.execute) image2.functions.push(functionSeed(address, { name, source: "export", confidence: 0.95 }));
    }
  }
  function executableRvaRange(image2, beginRva, size = 1) {
    if (!Number.isInteger(beginRva) || beginRva <= 0 || !Number.isInteger(size) || size <= 0) return false;
    const begin = image2.imageBase + BigInt(beginRva), end = begin + BigInt(size), sec = image2.sectionAt(begin);
    return !!(sec?.perms?.execute && end <= sec.address + sec.size);
  }
  function parseExceptionFunctions(r, dir, image2, machine, sharedBudget = null) {
    if (!dir || !dir.rva || !dir.size) return;
    const budget = ensureBudget(image2, sharedBudget);
    const span = mappedFileSpanForRva(image2, dir.rva, dir.size);
    if (!span) {
      budget.partial("exception:directory-span", "PE exception directory crosses a mapped boundary");
      return;
    }
    const off = span.start, end = span.spanEnd;
    if (machine === 34404) {
      let previousBegin = null, previousEnd = null;
      for (let p = off; p + 12 <= end; p += 12) {
        if (!budget.take({ inputBytes: 12, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 128 }, "exception-record")) break;
        const begin = r.u32(p), finish = r.u32(p + 4), unwind = r.u32(p + 8);
        const ordered = previousBegin == null || begin > previousBegin && begin >= previousEnd;
        if (!begin || finish <= begin || !ordered || !executableRvaRange(image2, begin, finish - begin)) {
          if (begin || finish) image2.warnings.push(`Ignored ${!ordered ? "overlapping/out-of-order" : "invalid/unmapped"} x64 exception range RVA 0x${begin.toString(16)}..0x${finish.toString(16)}`);
          continue;
        }
        image2.functions.push(functionSeed(image2.imageBase + BigInt(begin), { size: BigInt(finish - begin), source: "exception", confidence: 0.999 }));
        image2.metadata.exceptionDirectory = image2.metadata.exceptionDirectory || { count: 0, kind: "x64-pdata" };
        image2.metadata.exceptionDirectory.count++;
        previousBegin = begin;
        previousEnd = finish;
        void unwind;
      }
    } else if (machine === 43620 || machine === 42561) {
      let previousBegin = null, previousEnd = null;
      for (let p = off; p + 8 <= end; p += 8) {
        if (!budget.take({ inputBytes: 8, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 128 }, "exception-record")) break;
        const begin = r.u32(p), unwindData = r.u32(p + 4);
        if (!begin || previousBegin != null && begin <= previousBegin || !executableRvaRange(image2, begin, 1)) {
          if (begin) image2.warnings.push(`Ignored ARM64 exception entry outside executable order/range at RVA 0x${begin.toString(16)}`);
          continue;
        }
        let size = null;
        if ((unwindData & 3) !== 0) {
          const functionLength = unwindData >>> 2 & 2047;
          if (functionLength) {
            const bytes = functionLength * 4;
            if (previousEnd != null && begin < previousEnd || !executableRvaRange(image2, begin, bytes)) {
              image2.warnings.push(`Ignored overlapping/unmapped ARM64 exception range at RVA 0x${begin.toString(16)}`);
              continue;
            }
            size = BigInt(bytes);
          }
        }
        image2.functions.push(functionSeed(image2.imageBase + BigInt(begin), { size, source: "exception", confidence: 0.995 }));
        image2.metadata.exceptionDirectory = image2.metadata.exceptionDirectory || { count: 0, kind: "arm64-pdata" };
        image2.metadata.exceptionDirectory.count++;
        previousBegin = begin;
        previousEnd = size == null ? null : begin + Number(size);
      }
    }
  }
  function allowedBaseRelocationTypes(machine) {
    if (machine === 332) return /* @__PURE__ */ new Set([1, 2, 3, 4]);
    if (machine === 34404) return /* @__PURE__ */ new Set([1, 2, 3, 4, 10]);
    if (machine === 448 || machine === 452) return /* @__PURE__ */ new Set([3, 5, 7]);
    if (machine === 43620 || machine === 42561) return /* @__PURE__ */ new Set([4, 5, 6, 7, 8, 10]);
    return /* @__PURE__ */ new Set([1, 2, 3, 4, 5, 6, 7, 8, 10]);
  }
  function parseBaseRelocations(r, dir, image2, machine = null, sharedBudget = null) {
    if (!dir || !dir.rva || dir.size < 8) return;
    const budget = ensureBudget(image2, sharedBudget);
    const span = mappedFileSpanForRva(image2, dir.rva, dir.size);
    if (!span) {
      budget.partial("relocations:directory-span", "PE base-relocation directory crosses a mapped boundary");
      return;
    }
    let off = span.start;
    const end = span.spanEnd, allowed = allowedBaseRelocationTypes(machine);
    while (off + 8 <= end) {
      if (!budget.take({ inputBytes: 8, records: 1, operations: 1, estimatedHeapBytes: 32 }, "relocation-block")) break;
      const pageRva = r.u32(off), blockSize = r.u32(off + 4);
      if (blockSize < 8 || (blockSize & 1) !== 0 || off + blockSize > end) {
        budget.partial("relocations:malformed-block", `Malformed PE base-relocation block at file offset 0x${off.toString(16)}`);
        break;
      }
      const count = (blockSize - 8) / 2;
      for (let i = 0; i < count; i++) {
        if (!budget.take({ inputBytes: 2, records: 1, objects: 1, operations: 1, estimatedHeapBytes: 112 }, "relocation-entry")) break;
        const raw = r.u16(off + 8 + i * 2), type = raw >>> 12, within = raw & 4095;
        if (!type) continue;
        if (!allowed.has(type)) {
          image2.warnings.push(`Ignored reserved/unsupported PE base relocation type ${type} at RVA 0x${(pageRva + within).toString(16)}`);
          continue;
        }
        const address = image2.imageBase + BigInt(pageRva + within);
        image2.relocations.push({ address, fileOffset: image2.addressToOffset(address), type, symbol: null, addend: null, section: null, source: "PE-base-reloc" });
      }
      off += blockSize;
    }
  }
  function parseCoffSymbols(r, ptr, count, image2, sharedBudget = null) {
    if (!ptr || !count) return;
    const budget = ensureBudget(image2, sharedBudget);
    const tableBytes = count * 18;
    if (!Number.isSafeInteger(tableBytes) || ptr + tableBytes > r.length) {
      budget.partial("coff:symbol-table-span", "PE COFF symbol table exceeds the input");
      return;
    }
    const strBase = ptr + tableBytes;
    if (strBase + 4 > r.length) {
      budget.partial("coff:string-table-header", "PE COFF string table header is missing");
      return;
    }
    const strSize = r.u32(strBase), strEnd = Math.min(r.length, strBase + Math.max(4, strSize));
    if (strBase + strSize > r.length) budget.partial("coff:string-table-span", "PE COFF string table is truncated");
    let i = 0;
    while (i < count) {
      if (!budget.take({ inputBytes: 18, records: 1, objects: 2, operations: 2, estimatedHeapBytes: 256 }, "coff-symbol-record")) break;
      const p = ptr + i * 18;
      let name;
      if (r.u32(p) === 0) {
        const noff = r.u32(p + 4);
        name = noff >= 4 && noff < strSize && strBase + noff < strEnd ? mappedCStringAtOffset(r, strBase + noff, strEnd, budget, "COFF symbol") : "";
      } else {
        name = r.ascii(p, 8);
        if (name && !budget.take({ stringBytes: name.length * 2, estimatedHeapBytes: name.length * 2 + 32 }, "coff-inline-name")) name = "";
      }
      const value = r.u32(p + 8), secNo = r.i16(p + 12), type = r.u16(p + 14), storage = r.u8(p + 16), aux = r.u8(p + 17);
      const sec = image2.sections.find((s) => s.index === secNo);
      const address = sec ? sec.address + BigInt(value) : 0n;
      if (name) {
        const derivedFunction = !!(type & 32), executableExternal = !!(sec && sec.perms.execute && storage === 2);
        image2.symbols.push({ name, address, size: null, kind: derivedFunction ? "function" : "symbol", binding: storage === 2 ? "global" : "local", defined: secNo > 0, sectionIndex: secNo, source: "COFF" });
        if (derivedFunction && address) image2.functions.push(functionSeed(address, { name, source: "symbol", confidence: 0.98, exactFunctionStart: true, functionStartEvidence: "COFF derived function type" }));
        else if (executableExternal && address) image2.functions.push(functionSeed(address, { name, source: "symbol-heuristic", confidence: 0.55 }));
      }
      if (aux > count - i - 1) {
        budget.partial("coff:aux-overrun", "PE COFF auxiliary symbol records exceed declared symbol count");
        break;
      }
      i += 1 + aux;
    }
  }
  function directory(dirs, index) {
    return dirs[index] || { rva: 0, size: 0 };
  }
  function peMachineName(m) {
    return { 332: "x86", 34404: "x86_64", 448: "arm", 452: "armv7", 43620: "arm64", 42561: "arm64ec", 20530: "riscv32", 20580: "riscv64" }[m] || `machine-${m.toString(16)}`;
  }
  function resolveCoffSectionName(r, inlineName, ptrSymbols, count) {
    const raw = String(inlineName || "");
    const m = /^\/(\d+)$/.exec(raw);
    if (!m) return raw;
    if (!ptrSymbols || !Number.isInteger(count) || count < 0) return raw;
    const stringBase = ptrSymbols + count * 18;
    if (!Number.isSafeInteger(stringBase) || stringBase < 0 || stringBase + 4 > r.length) return raw;
    const stringSize = r.u32(stringBase);
    const offset = Number(m[1]);
    if (!Number.isSafeInteger(offset) || offset < 4 || offset >= stringSize || stringBase + offset >= r.length) return raw;
    return r.cstring(stringBase + offset, Math.min(stringSize - offset, r.length - stringBase - offset)) || raw;
  }
  function rvaFromDelayField(value, attrs, image2) {
    if (!value) return 0;
    if (attrs & 1) return value >>> 0;
    const va = BigInt(value >>> 0), base = image2.imageBase;
    if (va < base || va - base > 0xffffffffn) return 0;
    return Number(va - base);
  }
  function parseDelayImports(r, dir, image2, sharedBudget = null) {
    if (!dir || !dir.rva || dir.size < 32) return;
    const budget = ensureBudget(image2, sharedBudget);
    const dirRange = mappedFileSpanForRva(image2, dir.rva, dir.size);
    if (!dirRange) {
      budget.partial("delay-imports:directory-span", "PE delay-import directory crosses a mapped boundary");
      return;
    }
    let off = dirRange.start;
    const end = dirRange.spanEnd, ptrSize = image2.bits === 64 ? 8 : 4;
    for (let guard = 0; guard < 65536 && off + 32 <= end; guard++, off += 32) {
      if (!budget.take({ inputBytes: 32, records: 1, operations: 1, estimatedHeapBytes: 32 }, "delay-import-descriptor")) break;
      const attrs = r.u32(off), nameField = r.u32(off + 4), iatField = r.u32(off + 12), intField = r.u32(off + 16), bound = r.u32(off + 20), unload = r.u32(off + 24), stamp = r.u32(off + 28);
      if (!(attrs || nameField || iatField || intField || bound || unload || stamp)) break;
      const nameRva = rvaFromDelayField(nameField, attrs, image2), iatRva = rvaFromDelayField(iatField, attrs, image2), intRva = rvaFromDelayField(intField, attrs, image2);
      const library = mappedCStringAtRva(r, image2, nameRva, budget, "PE delay import library");
      const iatRange = mappedFileRangeForRva(image2, iatRva), thunkRange = mappedFileRangeForRva(image2, intRva || iatRva);
      if (!library || !iatRva || !iatRange || !thunkRange) {
        budget.partial("delay-imports:malformed-descriptor", "Ignored malformed PE delay-import descriptor");
        continue;
      }
      image2.libraries.push(library);
      let terminated = false;
      for (let index = 0; index < 1e5; index++) {
        const thunkOff = thunkRange.start + index * ptrSize, iatOff = iatRange.start + index * ptrSize;
        if (thunkOff + ptrSize > thunkRange.end || iatOff + ptrSize > iatRange.end || thunkOff + ptrSize > r.length || iatOff + ptrSize > r.length) break;
        if (!budget.take({ inputBytes: ptrSize * 2, records: 1, objects: 1, operations: 2, estimatedHeapBytes: 192 }, "delay-import-thunk")) break;
        const raw = image2.bits === 64 ? r.u64(thunkOff) : BigInt(r.u32(thunkOff));
        if (raw === 0n) {
          terminated = true;
          break;
        }
        const ordinalMask = image2.bits === 64 ? 0x8000000000000000n : 0x80000000n;
        let name = null, ordinal = null, hint = null;
        if (raw & ordinalMask) ordinal = Number(raw & 0xffffn);
        else {
          let ibnRva;
          if (attrs & 1) {
            const masked = raw & (image2.bits === 64 ? 0x7fffffffffffffffn : 0x7fffffffn);
            if (masked > 0xffffffffn) continue;
            ibnRva = Number(masked);
          } else {
            const va = raw & (image2.bits === 64 ? 0x7fffffffffffffffn : 0x7fffffffn);
            ibnRva = va >= image2.imageBase && va - image2.imageBase <= 0xffffffffn ? Number(va - image2.imageBase) : 0;
          }
          const ibnRange = mappedFileRangeForRva(image2, ibnRva);
          if (ibnRange && ibnRange.start + 2 < ibnRange.end) {
            hint = r.u16(ibnRange.start);
            name = mappedCStringAtOffset(r, ibnRange.start + 2, ibnRange.end, budget, "PE delay import name");
          }
          if (!name) {
            image2.warnings.push(`Ignored malformed PE delay-import thunk for ${library || "<unknown>"}`);
            continue;
          }
        }
        const iatAddress = image2.imageBase + BigInt(iatRva + index * ptrSize);
        image2.imports.push({ name: name || `#${ordinal}`, library, ordinal, hint, source: "PE-delay-import", sites: [{ address: iatAddress, offset: BigInt(iatOff), kind: "delay-iat" }] });
      }
      if (!terminated) budget.partial("delay-imports:unterminated-thunk", `PE delay-import thunk table for ${library} reached its mapped boundary`);
    }
  }
  function readPointer(r, off, bits) {
    return bits === 64 ? r.u64(off) : BigInt(r.u32(off));
  }
  function parseTlsDirectory(r, dir, image2, sharedBudget = null) {
    const need = image2.bits === 64 ? 40 : 24;
    if (!dir || !dir.rva || dir.size < need) return;
    const budget = ensureBudget(image2, sharedBudget);
    const hdr = mappedFileSpanForRva(image2, dir.rva, need);
    if (!hdr) {
      budget.partial("tls:directory-span", "PE TLS directory header is not fully file-backed");
      return;
    }
    const off = hdr.start, callbacksVa = readPointer(r, off + (image2.bits === 64 ? 24 : 12), image2.bits), callbacks = [];
    if (callbacksVa) {
      const ptrSize = image2.bits === 64 ? 8 : 4, range = mappedFileRangeForAddress(image2, callbacksVa);
      if (!range) {
        budget.partial("tls:callback-table-span", "PE TLS callback table is not file-backed");
      } else {
        let terminated = false;
        for (let i = 0, p = range.start; i < 65536 && p + ptrSize <= range.end; i++, p += ptrSize) {
          if (!budget.take({ inputBytes: ptrSize, records: 1, objects: 1, operations: 1, estimatedHeapBytes: 128 }, "tls-callback")) break;
          const target = readPointer(r, p, image2.bits);
          if (!target) {
            terminated = true;
            break;
          }
          const sec = image2.sectionAt(target);
          if (!sec?.perms?.execute) continue;
          callbacks.push(target);
          image2.functions.push(functionSeed(target, { source: "tls-callback", confidence: 0.999 }));
        }
        if (!terminated) budget.partial("tls:unterminated-callback-table", "PE TLS callback table reached its mapped boundary without a zero terminator");
      }
    }
    image2.metadata.tls = { callbacks, callbacksAddress: callbacksVa || null };
  }
  function parseLoadConfig(r, dir, image2, sharedBudget = null) {
    if (!dir || !dir.rva || dir.size < 4) return;
    const budget = ensureBudget(image2, sharedBudget), head = mappedFileSpanForRva(image2, dir.rva, 4);
    if (!head) {
      budget.partial("load-config:header-span", "PE load-config header is not file-backed");
      return;
    }
    const off = head.start, declared = Math.min(r.u32(off), dir.size);
    const full = mappedFileSpanForRva(image2, dir.rva, declared);
    if (!full) {
      budget.partial("load-config:directory-span", "PE load-config directory crosses a mapped boundary");
      return;
    }
    const is64 = image2.bits === 64, tableOffset = is64 ? 128 : 80, countOffset = is64 ? 136 : 84, flagsOffset = is64 ? 144 : 88, ptrSize = is64 ? 8 : 4;
    if (declared < countOffset + ptrSize) return;
    const tableVa = readPointer(r, off + tableOffset, image2.bits), count64 = readPointer(r, off + countOffset, image2.bits), guardFlags = declared >= flagsOffset + 4 ? r.u32(off + flagsOffset) : 0, extra = guardFlags >>> 28 & 15, entrySize = 4 + extra, functions = [];
    const tableRange = tableVa ? mappedFileRangeForAddress(image2, tableVa) : null;
    if (tableVa && !tableRange) budget.partial("load-config:guardcf-table-span", "PE GuardCF table is not file-backed");
    if (tableRange) {
      const capacity = Math.floor((tableRange.end - tableRange.start) / entrySize);
      if (count64 > BigInt(capacity)) budget.partial("load-config:guardcf-count-span", "PE GuardCF count exceeds its mapped file-backed table");
      const count = Number(count64 < BigInt(capacity) ? count64 : BigInt(capacity));
      for (let i = 0; i < count; i++) {
        if (!budget.take({ inputBytes: entrySize, records: 1, objects: 1, operations: 1, estimatedHeapBytes: 128 }, "guardcf-function")) break;
        const p = tableRange.start + i * entrySize, rva = r.u32(p);
        if (!rva) continue;
        const address = image2.imageBase + BigInt(rva), sec = image2.sectionAt(address);
        if (!sec?.perms?.execute) continue;
        functions.push(address);
        image2.functions.push(functionSeed(address, { source: "guard-cf", confidence: 0.995 }));
      }
    }
    image2.metadata.loadConfig = { guardFlags, guardCFFunctionTable: tableVa || null, guardCFFunctionCount: count64, guardCFFunctions: functions };
  }

  // js/binary/pe.js
  var IMAGE_DIRECTORY_ENTRY_EXPORT = 0;
  var IMAGE_DIRECTORY_ENTRY_IMPORT = 1;
  var IMAGE_DIRECTORY_ENTRY_EXCEPTION = 3;
  var IMAGE_DIRECTORY_ENTRY_BASERELOC = 5;
  var IMAGE_DIRECTORY_ENTRY_TLS = 9;
  var IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG = 10;
  var IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT = 13;
  function seedValidatedEntrypoint(image2, entryRva, sizeOfImage, machine) {
    const address = image2.imageBase + BigInt(entryRva);
    const reject = (reason) => {
      image2.warnings.push(`PE entrypoint 0x${entryRva.toString(16)} rejected: ${reason}`);
      image2.metadata.entrypointValid = false;
      image2.metadata.entrypointDiagnostic = reason;
    };
    if (entryRva >= sizeOfImage) {
      reject("RVA is outside SizeOfImage");
      return;
    }
    const segment = image2.segments.find((s) => s.source === "PE-section" && address >= s.address && address < s.address + s.size);
    if (!segment) {
      reject("RVA is not mapped by a section");
      return;
    }
    if (!segment.perms?.execute) {
      reject("section is not executable");
      return;
    }
    const offset = address - segment.address;
    if (offset < 0n || offset >= segment.fileSize) {
      reject("entrypoint has no file-backed instruction byte");
      return;
    }
    const alignment = machine === 43620 || machine === 448 || machine === 452 ? 4n : 1n;
    if (address % alignment !== 0n) {
      reject(`address is not ${alignment}-byte aligned`);
      return;
    }
    image2.metadata.entrypointValid = true;
    image2.metadata.entrypointDiagnostic = null;
    image2.functions.push(functionSeed(address, { source: "entrypoint", confidence: 0.9 }));
  }
  function parsePE(input, options = {}) {
    const bytes = new ByteView(input).bytes;
    const r = new ByteView(bytes, { littleEndian: true });
    if (r.length < 64 || r.u16(0) !== 23117) throw new Error("not a PE file");
    const pe = r.u32(60);
    if (pe + 24 > r.length || r.u32(pe) !== 17744) throw new Error("invalid PE signature");
    const coff = pe + 4;
    const machine = r.u16(coff);
    const numberOfSections = r.u16(coff + 2);
    const timestamp = r.u32(coff + 4);
    const ptrSymbols = r.u32(coff + 8);
    const numberOfSymbols = r.u32(coff + 12);
    const sizeOptional = r.u16(coff + 16);
    const characteristics = r.u16(coff + 18);
    const opt = coff + 20;
    if (opt + sizeOptional > r.length) throw new Error("PE optional header is truncated");
    if (sizeOptional < 2) throw new Error("PE optional header is too small for its magic");
    const magic = r.u16(opt);
    if (magic !== 267 && magic !== 523) throw new Error(`unsupported PE optional magic 0x${magic.toString(16)}`);
    const bits = magic === 523 ? 64 : 32;
    const minimumOptionalSize = bits === 64 ? 112 : 96;
    if (sizeOptional < minimumOptionalSize) throw new Error(`PE optional header size ${sizeOptional} is smaller than ${minimumOptionalSize}`);
    const entryRva = r.u32(opt + 16);
    const imageBase = bits === 64 ? r.u64(opt + 24) : BigInt(r.u32(opt + 28));
    const sectionAlignment = r.u32(opt + 32);
    const fileAlignment = r.u32(opt + 36);
    const sizeOfImage = r.u32(opt + 56);
    const sizeOfHeaders = r.u32(opt + 60);
    const subsystem = r.u16(opt + 68);
    const numberOfRvaAndSizes = r.u32(opt + (bits === 64 ? 108 : 92));
    const dirBase = opt + (bits === 64 ? 112 : 96);
    const directories = [];
    const dirCount = Math.min(numberOfRvaAndSizes, 16, Math.max(0, Math.floor((opt + sizeOptional - dirBase) / 8)));
    for (let i = 0; i < dirCount; i++) directories.push({ rva: r.u32(dirBase + i * 8), size: r.u32(dirBase + i * 8 + 4) });
    const image2 = new BinaryImage(bytes, {
      format: "pe",
      arch: peMachineName(machine),
      bits,
      endian: "little",
      platform: "windows",
      imageBase,
      entrypoint: entryRva ? imageBase + BigInt(entryRva) : null,
      metadata: { machine, timestamp, characteristics, subsystem, sectionAlignment, fileAlignment, sizeOfImage, sizeOfHeaders, directories }
    });
    image2.addSegment({ name: "headers", address: imageBase, size: BigInt(sizeOfHeaders), fileOffset: 0n, fileSize: BigInt(Math.min(sizeOfHeaders, bytes.length)), perms: { read: true, write: false, execute: false }, source: "PE-headers" });
    const secBase = opt + sizeOptional;
    if (numberOfSections > 4096 || secBase + numberOfSections * 40 > r.length) throw new Error("PE section table is invalid");
    for (let i = 0; i < numberOfSections; i++) {
      const p = secBase + i * 40;
      const name = resolveCoffSectionName(r, r.ascii(p, 8), ptrSymbols, numberOfSymbols);
      const virtualSize = r.u32(p + 8);
      const virtualAddress = r.u32(p + 12);
      const sizeRaw = r.u32(p + 16);
      const ptrRaw = r.u32(p + 20);
      const flags = r.u32(p + 36);
      const address = imageBase + BigInt(virtualAddress);
      const virtualExtent = BigInt(virtualSize || sizeRaw);
      const rawAvailable = BigInt(Math.min(sizeRaw, Math.max(0, bytes.length - ptrRaw)));
      const mappedFileSize = rawAvailable < virtualExtent ? rawAvailable : virtualExtent;
      const perms = { read: !!(flags & 1073741824), write: !!(flags & 2147483648), execute: !!(flags & 536870912) };
      image2.addSegment({ name, address, size: virtualExtent, fileOffset: BigInt(ptrRaw), fileSize: mappedFileSize, perms, flags, source: "PE-section" });
      image2.addSection({ name, address, size: virtualExtent, fileOffset: BigInt(ptrRaw), fileSize: mappedFileSize, perms, flags, type: null, index: i + 1, source: "PE-section" });
    }
    if (entryRva) seedValidatedEntrypoint(image2, entryRva, sizeOfImage, machine);
    const metadataBudget = createPEMetadataBudget(image2, { signal: options.signal, limits: options.metadataLimits });
    parseCoffSymbols(r, ptrSymbols, numberOfSymbols, image2, metadataBudget);
    parseImports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_IMPORT), image2, metadataBudget);
    parseExports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXPORT), image2, metadataBudget);
    parseExceptionFunctions(r, directory(directories, IMAGE_DIRECTORY_ENTRY_EXCEPTION), image2, machine, metadataBudget);
    parseBaseRelocations(r, directory(directories, IMAGE_DIRECTORY_ENTRY_BASERELOC), image2, machine, metadataBudget);
    parseDelayImports(r, directory(directories, IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT), image2, metadataBudget);
    parseTlsDirectory(r, directory(directories, IMAGE_DIRECTORY_ENTRY_TLS), image2, metadataBudget);
    parseLoadConfig(r, directory(directories, IMAGE_DIRECTORY_ENTRY_LOAD_CONFIG), image2, metadataBudget);
    return image2.finalize();
  }

  // js/binary/source.js
  var DEFAULT_MAX_READ_LENGTH = 16 * 1024 * 1024;
  var MAX_SAFE_BIGINT2 = BigInt(Number.MAX_SAFE_INTEGER);
  var ByteSourceError = class extends Error {
    constructor(message, code = "BYTE_SOURCE_ERROR") {
      super(message);
      this.name = "ByteSourceError";
      this.code = code;
    }
  };
  var ByteSourceRangeError = class extends ByteSourceError {
    constructor(message, { offset = null, length = null, size = null } = {}) {
      super(message, "BYTE_SOURCE_RANGE_ERROR");
      this.name = "ByteSourceRangeError";
      this.offset = offset;
      this.length = length;
      this.size = size;
    }
  };
  var ByteSourceLimitError = class extends ByteSourceError {
    constructor(message) {
      super(message, "BYTE_SOURCE_LIMIT_ERROR");
      this.name = "ByteSourceLimitError";
    }
  };
  function nonNegativeBigInt(value, label = "value") {
    if (typeof value === "bigint") {
      if (value < 0n) throw new ByteSourceRangeError(`${label} must be non-negative`);
      return value;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ByteSourceRangeError(`${label} must be a non-negative safe integer or bigint`);
    }
    return BigInt(value);
  }
  function safeNumber(value, label = "value") {
    const n = nonNegativeBigInt(value, label);
    if (n > MAX_SAFE_BIGINT2) throw new ByteSourceLimitError(`${label} exceeds JavaScript's safe integer range`);
    return Number(n);
  }
  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error("ByteSource read was aborted");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    throw error;
  }
  function asBytes(value, label = "read result") {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new ByteSourceError(`${label} must be a Uint8Array, ArrayBuffer, or ArrayBufferView`);
  }
  var ByteSource = class {
    constructor(size, { maxReadLength = DEFAULT_MAX_READ_LENGTH } = {}) {
      this.size = nonNegativeBigInt(size, "source size");
      if (!Number.isSafeInteger(maxReadLength) || maxReadLength <= 0) {
        throw new ByteSourceLimitError("maxReadLength must be a positive safe integer");
      }
      this.maxReadLength = maxReadLength;
    }
    validateRange(offset, length) {
      const o = nonNegativeBigInt(offset, "read offset");
      const n64 = nonNegativeBigInt(length, "read length");
      if (n64 > BigInt(this.maxReadLength)) {
        throw new ByteSourceLimitError(`read length ${n64} exceeds the ${this.maxReadLength}-byte limit`);
      }
      if (o > this.size || n64 > this.size - o) {
        throw new ByteSourceRangeError("read outside source", { offset: o, length: n64, size: this.size });
      }
      return { offset: o, length: Number(n64) };
    }
    async read(_offset, _length, _options = {}) {
      throw new ByteSourceError("ByteSource.read() is not implemented");
    }
    async readExactly(offset, length, options = {}) {
      const range = this.validateRange(offset, length);
      throwIfAborted(options.signal);
      const bytes = asBytes(await this.read(range.offset, range.length, options));
      throwIfAborted(options.signal);
      if (bytes.byteLength !== range.length) {
        throw new ByteSourceRangeError(`truncated read: expected ${range.length} bytes, received ${bytes.byteLength}`, {
          offset: range.offset,
          length: BigInt(range.length),
          size: this.size
        });
      }
      return bytes;
    }
    subrange(offset, length) {
      return new SubrangeByteSource(this, offset, length);
    }
  };
  var MemoryByteSource = class extends ByteSource {
    constructor(input, options = {}) {
      const bytes = asBytes(input, "memory source");
      super(BigInt(bytes.byteLength), options);
      this.bytes = bytes;
    }
    async read(offset, length, options = {}) {
      const range = this.validateRange(offset, length);
      throwIfAborted(options.signal);
      const start = safeNumber(range.offset, "read offset");
      return this.bytes.subarray(start, start + range.length);
    }
  };
  var BlobByteSource = class extends ByteSource {
    constructor(blob, options = {}) {
      if (typeof Blob === "undefined" || !(blob instanceof Blob)) throw new TypeError("BlobByteSource expects a Blob or File");
      super(BigInt(blob.size), options);
      this.blob = blob;
    }
    async read(offset, length, options = {}) {
      const range = this.validateRange(offset, length);
      throwIfAborted(options.signal);
      const start = safeNumber(range.offset, "Blob read offset");
      const bytes = new Uint8Array(await this.blob.slice(start, start + range.length).arrayBuffer());
      throwIfAborted(options.signal);
      return bytes;
    }
  };
  var SubrangeByteSource = class extends ByteSource {
    constructor(parent, offset, length, options = {}) {
      const base = asByteSource(parent);
      const start = nonNegativeBigInt(offset, "subrange offset");
      const size = nonNegativeBigInt(length, "subrange length");
      if (start > base.size || size > base.size - start) {
        throw new ByteSourceRangeError("subrange outside source", { offset: start, length: size, size: base.size });
      }
      super(size, { maxReadLength: options.maxReadLength ?? base.maxReadLength });
      this.parent = base;
      this.offset = start;
    }
    async read(offset, length, options = {}) {
      const range = this.validateRange(offset, length);
      return this.parent.readExactly(this.offset + range.offset, range.length, options);
    }
  };
  var DelegatingByteSource = class extends ByteSource {
    constructor(source2, options = {}) {
      super(source2.size, { maxReadLength: options.maxReadLength ?? source2.maxReadLength ?? DEFAULT_MAX_READ_LENGTH });
      this.delegate = source2;
    }
    async read(offset, length, options = {}) {
      const range = this.validateRange(offset, length);
      throwIfAborted(options.signal);
      const bytes = asBytes(await this.delegate.read(range.offset, range.length, options));
      throwIfAborted(options.signal);
      if (bytes.byteLength !== range.length) {
        throw new ByteSourceRangeError(`truncated read: expected ${range.length} bytes, received ${bytes.byteLength}`, {
          offset: range.offset,
          length: BigInt(range.length),
          size: this.size
        });
      }
      return bytes;
    }
  };
  function asByteSource(input, options = {}) {
    if (input instanceof ByteSource) {
      const requested = options?.maxReadLength;
      return requested == null || requested === input.maxReadLength ? input : new DelegatingByteSource(input, options);
    }
    if (input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) return new MemoryByteSource(input, options);
    if (typeof Blob !== "undefined" && input instanceof Blob) return new BlobByteSource(input, options);
    if (input && (typeof input.size === "bigint" || Number.isSafeInteger(input.size)) && typeof input.read === "function") {
      return new DelegatingByteSource(input, options);
    }
    throw new TypeError("Expected bytes, Blob/File, or an object with size and async read(offset, length)");
  }

  // js/binary/source-reader.js
  var SourceRangeMissingError = class extends BinaryReadError {
    constructor(offset, length) {
      super(`source range is not cached (${length} bytes)`, offset);
      this.name = "SourceRangeMissingError";
      this.code = "BINARY_SOURCE_RANGE_MISSING";
      this.offset = BigInt(offset);
      this.length = BigInt(length);
    }
  };
  function throwIfSourceAborted(signal) {
    if (!signal?.aborted) return;
    const cancelled = new Error("binary metadata read aborted");
    cancelled.name = "AbortError";
    cancelled.code = "BYTE_SOURCE_CANCELLED";
    cancelled.reason = signal.reason;
    throw cancelled;
  }
  var SparseByteBuffer = class {
    constructor(size) {
      this.size = nonNegativeBigInt(size, "binary source size");
      this.length = this.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(this.size);
      this.__binaryByteBacking = true;
      this.chunks = [];
    }
    additionalBytes(offset, length) {
      const start = nonNegativeBigInt(offset, "cached range offset");
      const count = nonNegativeBigInt(length, "cached range length");
      const end = start + count;
      if (end > this.size) throw new BinaryReadError("cached range exceeds source", start);
      let overlap = 0n;
      for (const chunk of this.chunks) {
        const lo = chunk.start > start ? chunk.start : start;
        const hi = chunk.end < end ? chunk.end : end;
        if (hi > lo) overlap += hi - lo;
      }
      return safeNumber(count - overlap, "new cached byte count");
    }
    add(offset, input) {
      const start = nonNegativeBigInt(offset, "cached range offset");
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      const end = start + BigInt(bytes.length);
      if (end > this.size) throw new BinaryReadError("cached range exceeds source", start);
      if (!bytes.length) return 0;
      const added = this.additionalBytes(start, bytes.length);
      let mergeStart = start, mergeEnd = end;
      const keep = [];
      const merge = [];
      for (const chunk of this.chunks) {
        if (chunk.end < start || chunk.start > end) keep.push(chunk);
        else {
          merge.push(chunk);
          if (chunk.start < mergeStart) mergeStart = chunk.start;
          if (chunk.end > mergeEnd) mergeEnd = chunk.end;
        }
      }
      const mergedLength = safeNumber(mergeEnd - mergeStart, "merged cached range");
      const merged = new Uint8Array(mergedLength);
      for (const chunk of merge) merged.set(chunk.bytes, safeNumber(chunk.start - mergeStart, "cached chunk offset"));
      merged.set(bytes, safeNumber(start - mergeStart, "cached input offset"));
      keep.push({ start: mergeStart, end: mergeEnd, bytes: merged });
      keep.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      this.chunks = keep;
      return added;
    }
    subarray(start, end = this.size) {
      const begin = nonNegativeBigInt(start, "cached read start");
      const finish = nonNegativeBigInt(end, "cached read end");
      if (finish < begin || finish > this.size) throw new BinaryReadError("read outside file", begin);
      const size = safeNumber(finish - begin, "cached read length");
      if (!size) return new Uint8Array();
      let cursor = begin;
      for (const chunk of this.chunks) {
        if (chunk.end <= cursor) continue;
        if (chunk.start > cursor) throw new SourceRangeMissingError(cursor, finish - cursor);
        cursor = finish < chunk.end ? finish : chunk.end;
        if (cursor === finish) break;
      }
      if (cursor !== finish) throw new SourceRangeMissingError(cursor, finish - cursor);
      const out = new Uint8Array(size);
      cursor = begin;
      for (const chunk of this.chunks) {
        if (chunk.end <= cursor) continue;
        const takeEnd = finish < chunk.end ? finish : chunk.end;
        const from = safeNumber(cursor - chunk.start, "cached chunk read offset");
        const to = safeNumber(takeEnd - chunk.start, "cached chunk read end");
        out.set(chunk.bytes.subarray(from, to), safeNumber(cursor - begin, "cached output offset"));
        cursor = takeEnd;
        if (cursor === finish) return out;
      }
      return out;
    }
  };
  async function parseSourceRanges(source2, parser, parserOptions = {}, options = {}) {
    const pageSize = options.pageSize ?? 256 * 1024;
    const maxPageSize = options.maxPageSize ?? pageSize;
    const maxCachedBytes = options.maxCachedBytes ?? 64 * 1024 * 1024;
    const maxReads = options.maxReads ?? 4096;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new ByteSourceLimitError("pageSize must be a positive safe integer");
    if (!Number.isSafeInteger(maxPageSize) || maxPageSize < pageSize) throw new ByteSourceLimitError("maxPageSize must be a safe integer at least as large as pageSize");
    if (!Number.isSafeInteger(maxCachedBytes) || maxCachedBytes <= 0) throw new ByteSourceLimitError("maxCachedBytes must be a positive safe integer");
    if (!Number.isSafeInteger(maxReads) || maxReads <= 0) throw new ByteSourceLimitError("maxReads must be a positive safe integer");
    const sparse = new SparseByteBuffer(source2.size);
    let reads = 0;
    let parserPasses = 0;
    let cachedBytes = 0;
    let totalRequestedBytes = 0;
    let largestRead = 0;
    const initial = options.initial || [];
    for (const item of initial) {
      throwIfSourceAborted(options.signal);
      const added = sparse.additionalBytes(item.offset, item.bytes.byteLength);
      if (cachedBytes + added > maxCachedBytes) throw new ByteSourceLimitError(`initial metadata exceeds the ${maxCachedBytes}-byte cache limit`);
      sparse.add(item.offset, item.bytes);
      cachedBytes += added;
    }
    for (; ; ) {
      throwIfSourceAborted(options.signal);
      try {
        parserPasses++;
        const image2 = parser(sparse, parserOptions);
        throwIfSourceAborted(options.signal);
        image2.attachSource(source2, { discardBytes: true });
        image2.metadata.sourceBacked = true;
        image2.metadata.sourceReads = { requests: reads, parserPasses, cachedBytes, pageSize, maxPageSize, totalRequestedBytes, largestRead };
        return image2;
      } catch (error) {
        if (error?.code !== "BINARY_SOURCE_RANGE_MISSING") throw error;
        throwIfSourceAborted(options.signal);
        const missingEnd = error.offset + error.length > source2.size ? source2.size : error.offset + error.length;
        let cursor = error.offset;
        let first = true;
        while (cursor < source2.size && (first || cursor < missingEnd)) {
          first = false;
          throwIfSourceAborted(options.signal);
          if (++reads > maxReads) throw new ByteSourceLimitError(`binary metadata required more than ${maxReads} range reads`);
          const remaining = source2.size - cursor;
          const budgetRemaining = maxCachedBytes - cachedBytes;
          if (budgetRemaining <= 0) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);
          const growthShift = Math.min(5, Math.floor((reads - 1) / 4));
          const adaptive = Math.min(maxPageSize, pageSize * 2 ** growthShift);
          const missing = missingEnd > cursor ? missingEnd - cursor : 0n;
          const wantedByParser = missing > BigInt(maxPageSize) ? maxPageSize : safeNumber(missing, "missing source range length");
          const requested = Math.max(pageSize, adaptive, wantedByParser);
          const requestLimit = Math.min(requested, maxPageSize, source2.maxReadLength, budgetRemaining);
          const length = Number(remaining < BigInt(requestLimit) ? remaining : BigInt(requestLimit));
          if (length <= 0) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);
          const bytes = await source2.readExactly(cursor, length, { signal: options.signal });
          throwIfSourceAborted(options.signal);
          const added = sparse.additionalBytes(cursor, bytes.byteLength);
          if (added > budgetRemaining) throw new ByteSourceLimitError(`binary metadata exceeds the ${maxCachedBytes}-byte cache limit`);
          sparse.add(cursor, bytes);
          cachedBytes += added;
          totalRequestedBytes += bytes.byteLength;
          largestRead = Math.max(largestRead, bytes.byteLength);
          cursor += BigInt(bytes.byteLength);
        }
      }
    }
  }

  // js/bytesource/strings.js
  function printableAscii(c) {
    return c === 9 || c >= 32 && c <= 126;
  }
  async function scanSourceStrings(image2, input, opts = {}) {
    const source2 = asByteSource(input);
    const min = Math.max(2, Number(opts.minLength) || 4);
    const max = Math.max(min, Math.min(64 * 1024, Number(opts.maxLength) || 4096));
    const limit = Math.max(1, Math.min(1e6, Number(opts.limit) || 2e5));
    const utf16Encodings = chooseUtf16Encodings(image2, opts.utf16);
    const includeExecutable = !!opts.includeExecutable;
    const chunkSize = Math.min(source2.maxReadLength, Math.max(64 * 1024, Number(opts.chunkSize) || 256 * 1024));
    const ranges = mappedRanges(image2, source2.size, includeExecutable);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const overlapBytes = Math.min(chunkSize, max * 2 + 2);
    for (const range of ranges) {
      let offset = range.start;
      let carry = new Uint8Array(0);
      while (offset < range.end && out.length < limit) {
        if (opts.signal?.aborted) return { results: out, cancelled: true, capped: false };
        const remaining = range.end - offset;
        const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
        let block;
        try {
          block = await source2.readExactly(offset, length, { signal: opts.signal });
        } catch (error) {
          if (opts.signal?.aborted || error?.name === "AbortError" || error?.code === "BYTE_SOURCE_CANCELLED") return { results: out, cancelled: true, capped: false };
          throw error;
        }
        const bytes = carry.length ? concat(carry, block) : block;
        const base = offset - BigInt(carry.length);
        scanAscii(image2, bytes, base, range, min, max, out, seen, limit);
        for (const encoding of utf16Encodings) {
          if (out.length >= limit) break;
          scanUtf16(image2, bytes, base, range, min, max, out, seen, limit, encoding);
        }
        const keep = Math.min(overlapBytes, bytes.length);
        carry = bytes.slice(bytes.length - keep);
        offset += BigInt(block.length);
        opts.onProgress?.({ done: offset - range.start, total: range.end - range.start, strings: out.length, section: range.section });
        if (!block.length) break;
      }
      if (out.length >= limit) break;
    }
    return { results: out, cancelled: false, capped: out.length >= limit };
  }
  function mappedRanges(image2, sourceSize, includeExecutable) {
    const items = image2.sections?.length ? image2.sections : image2.segments || [];
    const ranges = [];
    const dedupe = /* @__PURE__ */ new Set();
    for (const item of items) {
      const size = BigInt(item.fileSize ?? 0);
      const start = BigInt(item.fileOffset ?? 0);
      if (size <= 0n || start < 0n || start >= sourceSize) continue;
      if (!includeExecutable && item.perms?.execute) continue;
      const bounded = size > sourceSize - start ? sourceSize - start : size;
      if (bounded <= 0n) continue;
      const key = `${start}:${bounded}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      ranges.push({ start, end: start + bounded, section: item.name || null });
    }
    if (!ranges.length) ranges.push({ start: 0n, end: sourceSize, section: null });
    ranges.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
    return ranges;
  }
  function scanAscii(image2, bytes, base, range, min, max, out, seen, limit) {
    for (let p = 0; p < bytes.length && out.length < limit; ) {
      if (!printableAscii(bytes[p])) {
        p++;
        continue;
      }
      const start = p;
      let q = p;
      while (q < bytes.length && q - start < max && printableAscii(bytes[q])) q++;
      if (q - start >= min) emit(image2, bytes, base, start, q - start, "utf8", range, out, seen);
      p = q < bytes.length && printableAscii(bytes[q]) ? q : Math.max(q + 1, p + 1);
    }
  }
  function chooseUtf16Encodings(image2, option) {
    if (option === false) return [];
    if (option === "be" || option === "utf16be" || option === "utf-16be") return ["utf16be"];
    if (option === "le" || option === "utf16le" || option === "utf-16le") return ["utf16le"];
    if (option === "both") return ["utf16le", "utf16be"];
    return [image2?.endian === "big" ? "utf16be" : "utf16le"];
  }
  function scanUtf16(image2, bytes, base, range, min, max, out, seen, limit, encoding) {
    const be = encoding === "utf16be";
    const printableAt = (p) => p + 1 < bytes.length && (be ? bytes[p] === 0 && printableAscii(bytes[p + 1]) : printableAscii(bytes[p]) && bytes[p + 1] === 0);
    for (let p = 0; p + 1 < bytes.length && out.length < limit; ) {
      if (!printableAt(p)) {
        p++;
        continue;
      }
      const start = p;
      let q = p;
      let chars = 0;
      while (q + 1 < bytes.length && chars < max && printableAt(q)) {
        chars++;
        q += 2;
      }
      if (chars >= min) emit(image2, bytes, base, start, q - start, encoding, range, out, seen);
      p = q + 1 < bytes.length && printableAt(q) ? q : Math.max(q + 2, p + 1);
    }
  }
  function emit(image2, bytes, base, localStart, byteLength, encoding, range, out, seen) {
    const fileOffset = base + BigInt(localStart);
    if (fileOffset < range.start || fileOffset >= range.end) return;
    const key = `${fileOffset}:${encoding}`;
    if (seen.has(key)) return;
    seen.add(key);
    const raw = bytes.subarray(localStart, localStart + byteLength);
    let text;
    try {
      text = new TextDecoder(encoding === "utf16le" ? "utf-16le" : encoding === "utf16be" ? "utf-16be" : "utf-8").decode(raw);
    } catch {
      text = "";
    }
    out.push({ text, encoding, fileOffset, address: image2.offsetToAddress(fileOffset), byteLength, section: range.section });
  }
  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // js/binary/source-loaders.js
  var FAT_KINDS = /* @__PURE__ */ new Map([
    ["cafebabe", { bits: 32, littleEndian: false }],
    ["cafebabf", { bits: 64, littleEndian: false }],
    ["bebafeca", { bits: 32, littleEndian: true }],
    ["bfbafeca", { bits: 64, littleEndian: true }]
  ]);
  async function openBinarySource(input, opts = {}) {
    const sourceOptions = opts.source || {};
    const source2 = asByteSource(input, sourceOptions);
    const prefixLength = Number(source2.size < 16n ? source2.size : 16n);
    const prefix = await source2.readExactly(0n, prefixLength, { signal: opts.signal });
    const detected = detectBinary(prefix);
    const rangeOptions = withSignal(opts.ranges || {}, opts.signal);
    if (detected.format === "elf") return parseELFSource(source2, opts, prefix, rangeOptions);
    if (detected.format === "pe") return parsePESource(source2, opts, prefix, rangeOptions);
    if (detected.format === "macho") return parseMachOSource(source2, opts, prefix, rangeOptions);
    throw new Error("対応していない実行ファイル形式です（Mach-O / ELF / PE を判定できませんでした）。");
  }
  async function parseELFSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {
    const source2 = asByteSource(input, opts.source || {});
    const ranges = withSignal(rangeOptions, opts.signal);
    const magic = prefix || await readPrefix(source2, opts.signal);
    const image2 = await parseSourceRanges(source2, parseELF, {}, withInitial(magic, ranges));
    return withStrings(image2, source2, opts);
  }
  async function parsePESource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {
    const source2 = asByteSource(input, opts.source || {});
    const ranges = withSignal(rangeOptions, opts.signal);
    const magic = prefix || await readPrefix(source2, opts.signal);
    const image2 = await parseSourceRanges(source2, parsePE, {}, withInitial(magic, ranges));
    return withStrings(image2, source2, opts);
  }
  async function parseMachOSource(input, opts = {}, prefix = null, rangeOptions = opts.ranges || {}) {
    const source2 = asByteSource(input, opts.source || {});
    const ranges = withSignal(rangeOptions, opts.signal);
    const magic = prefix || await source2.readExactly(0n, Number(source2.size < 16n ? source2.size : 16n), { signal: opts.signal });
    const fat = fatKind(magic);
    if (!fat) {
      const image3 = await parseSourceRanges(source2, parseMachO, opts, withInitial(magic, ranges));
      return withStrings(image3, source2, opts);
    }
    if (source2.size < 8n) throw new Error("Mach-O universal header is truncated");
    const head = magic.byteLength >= 8 ? magic.subarray(0, 8) : await source2.readExactly(0n, 8, { signal: opts.signal });
    const hr = new ByteView(head, { littleEndian: fat.littleEndian });
    const count = hr.u32(4);
    if (count > 128) throw new Error(`unreasonable Mach-O slice count ${count}`);
    const entrySize = fat.bits === 64 ? 32 : 20;
    const tableSize = count * entrySize;
    if (8n + BigInt(tableSize) > source2.size) throw new Error("Mach-O universal slice table is truncated");
    const table = await source2.readExactly(8n, tableSize, { signal: opts.signal });
    const r = new ByteView(table, { littleEndian: fat.littleEndian, base: 8 });
    const all = [];
    for (let i = 0, p = 0; i < count; i++, p += entrySize) {
      const cpu = r.i32(p), subtype = r.i32(p + 4);
      const offset = fat.bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 8));
      const size = fat.bits === 64 ? r.u64(p + 16) : BigInt(r.u32(p + 12));
      all.push({ cpu, subtype, offset, size });
    }
    const valid = all.filter((slice) => slice.size > 0n && slice.offset <= source2.size && slice.size <= source2.size - slice.offset);
    const requestedIndex = opts.sliceIndex == null ? null : Number(opts.sliceIndex);
    if (requestedIndex != null && (!Number.isSafeInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= all.length)) {
      throw new Error(`requested Mach-O slice index ${opts.sliceIndex} is not present in the universal binary`);
    }
    const indexed = requestedIndex == null ? null : all[requestedIndex];
    if (indexed && !valid.includes(indexed)) throw new Error(`requested Mach-O slice index ${requestedIndex} is outside the active file`);
    const requested = indexed || (opts.arch ? valid.find((slice) => sliceArchName2(slice) === opts.arch) : null);
    if (requestedIndex == null && opts.arch && !requested) throw new Error(`requested Mach-O architecture ${opts.arch} is not present in the universal binary`);
    const selected = requested || valid.find((slice) => sliceArchName2(slice) === "arm64e") || valid.find((slice) => sliceArchName2(slice) === "arm64") || valid.find((slice) => sliceArchName2(slice) === "x86_64") || valid[0];
    if (!selected) throw new Error("Mach-O universal binary has no readable slice");
    const sliceSource = source2.subrange(selected.offset, selected.size);
    const slicePrefix = await readPrefix(sliceSource, opts.signal);
    const image2 = await parseSourceRanges(sliceSource, parseMachO, { ...opts, containerOffset: selected.offset }, withInitial(slicePrefix, ranges));
    image2.metadata.fat = {
      slices: all.map((slice) => ({ arch: sliceArchName2(slice), cpu: slice.cpu, subtype: slice.subtype, offset: slice.offset, size: slice.size })),
      selected: { arch: sliceArchName2(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size }
    };
    return withStrings(image2, sliceSource, opts);
  }
  async function withStrings(image2, source2, opts) {
    if (!opts.strings) return image2;
    const scanOpts = typeof opts.strings === "object" ? opts.strings : {};
    const result = await scanSourceStrings(image2, source2, { ...scanOpts, signal: scanOpts.signal ?? opts.signal });
    image2.strings = result.results;
    image2.metadata.sourceStrings = { cancelled: result.cancelled, capped: result.capped, count: result.results.length };
    return image2;
  }
  function withSignal(options, signal) {
    if (!signal || options.signal) return options;
    return { ...options, signal };
  }
  function withInitial(prefix, options) {
    if (!prefix?.byteLength) return options;
    return { ...options, initial: [{ offset: 0n, bytes: prefix }] };
  }
  async function readPrefix(source2, signal) {
    return source2.readExactly(0n, Number(source2.size < 16n ? source2.size : 16n), { signal });
  }
  function fatKind(bytes) {
    if (bytes.byteLength < 4) return null;
    let magic = "";
    for (let i = 0; i < 4; i++) magic += bytes[i].toString(16).padStart(2, "0");
    return FAT_KINDS.get(magic) || null;
  }
  function cpuName2(cpu) {
    const value = cpu >>> 0;
    return { 7: "x86", 12: "arm", 18: "ppc", 16777223: "x86_64", 16777228: "arm64", 33554444: "arm64_32" }[value] || `cpu-${value}`;
  }
  function subtypeBase2(subtype) {
    return subtype >>> 0 & 16777215;
  }
  function sliceArchName2(slice) {
    return cpuName2(slice.cpu) === "arm64" && subtypeBase2(slice.subtype) === 2 ? "arm64e" : cpuName2(slice.cpu);
  }

  // js/bytesource/cached.js
  var ByteSourceCancelledError = class extends Error {
    constructor(message = "ByteSource read was cancelled") {
      super(message);
      this.name = "ByteSourceCancelledError";
      this.code = "BYTE_SOURCE_CANCELLED";
    }
  };
  function throwIfCancelled(signal) {
    if (signal?.aborted) throw new ByteSourceCancelledError();
  }
  function waitForConsumer(promise, signal) {
    if (!signal) return promise;
    throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener?.("abort", onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, new ByteSourceCancelledError());
      signal.addEventListener?.("abort", onAbort, { once: true });
      promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }
  var CachedByteSource = class extends ByteSource {
    constructor(input, options = {}) {
      const source2 = asByteSource(input, options.source || {});
      super(source2.size, { maxReadLength: options.maxReadLength ?? source2.maxReadLength });
      this.source = source2;
      this.pageSize = options.pageSize ?? 256 * 1024;
      this.maxCachedBytes = options.maxCachedBytes ?? 8 * 1024 * 1024;
      if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0) throw new TypeError("pageSize must be a positive safe integer");
      if (!Number.isSafeInteger(this.maxCachedBytes) || this.maxCachedBytes < this.pageSize) throw new TypeError("maxCachedBytes must be at least one page");
      this.cache = /* @__PURE__ */ new Map();
      this.inflight = /* @__PURE__ */ new Map();
      this.cachedBytes = 0;
      this.generation = 0;
      this.stats = { requests: 0, hits: 0, misses: 0, backendBytesRead: 0, largestRead: 0 };
    }
    async read(offset, length, options = {}) {
      const range = this.validateRange(offset, length);
      throwIfCancelled(options.signal);
      this.stats.requests++;
      this.stats.largestRead = Math.max(this.stats.largestRead, range.length);
      if (range.length === 0) return new Uint8Array(0);
      const out = new Uint8Array(range.length);
      let done = 0;
      const start = range.offset;
      while (done < range.length) {
        throwIfCancelled(options.signal);
        const absolute = start + BigInt(done);
        const pageIndex = absolute / BigInt(this.pageSize);
        const pageOffset = Number(absolute % BigInt(this.pageSize));
        const page = await waitForConsumer(this.#page(pageIndex), options.signal);
        throwIfCancelled(options.signal);
        if (pageOffset >= page.length) break;
        const take = Math.min(page.length - pageOffset, range.length - done);
        out.set(page.subarray(pageOffset, pageOffset + take), done);
        done += take;
      }
      return done === range.length ? out : out.subarray(0, done);
    }
    async readExactly(offset, length, options = {}) {
      const range = this.validateRange(offset, length);
      const bytes = await this.read(range.offset, range.length, options);
      if (bytes.byteLength !== range.length) throw new Error(`truncated cached read: expected ${range.length}, received ${bytes.byteLength}`);
      return bytes;
    }
    async #page(pageIndex) {
      const key = pageIndex.toString();
      const cached = this.cache.get(key);
      if (cached) {
        this.stats.hits++;
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached;
      }
      this.stats.misses++;
      let promise = this.inflight.get(key);
      if (!promise) {
        const offset = pageIndex * BigInt(this.pageSize);
        const remaining = this.size - offset;
        const length = Number(remaining < BigInt(this.pageSize) ? remaining : BigInt(this.pageSize));
        const generation = this.generation;
        promise = (async () => {
          const bytes = await this.source.readExactly(offset, length);
          this.stats.backendBytesRead += bytes.byteLength;
          if (generation === this.generation) this.#remember(key, bytes);
          return bytes;
        })().finally(() => {
          if (this.inflight.get(key) === promise) this.inflight.delete(key);
        });
        this.inflight.set(key, promise);
      }
      return promise;
    }
    #remember(key, bytes) {
      if (this.cache.has(key)) this.#drop(key);
      this.cache.set(key, bytes);
      this.cachedBytes += bytes.byteLength;
      while (this.cachedBytes > this.maxCachedBytes && this.cache.size) {
        this.#drop(this.cache.keys().next().value);
      }
    }
    #drop(key) {
      const value = this.cache.get(key);
      if (!value) return;
      this.cachedBytes -= value.byteLength;
      this.cache.delete(key);
    }
    clear() {
      this.generation++;
      this.cache.clear();
      this.inflight.clear();
      this.cachedBytes = 0;
    }
    memoryStats() {
      return {
        bytesCached: this.cachedBytes,
        chunksCached: this.cache.size,
        pendingReads: this.inflight.size,
        ...this.stats
      };
    }
  };

  // js/i18n.js
  var current = "ja";
  function isJa() {
    return current === "ja";
  }
  function pick(ja, en) {
    return current === "ja" ? ja : en == null ? ja : en;
  }

  // js/arm64.js
  var REG_RE = /^(?:([wx])(\d{1,2})|(wzr|xzr)|(wsp|sp)|(lr|fp)|([bhsdq])(\d{1,2})|(v(\d{1,2})(?:\.(\d*[bhsdq]))?))$/i;
  function registerRole(num, isSp, isZr) {
    if (isSp) return { id: "sp", ja: "スタックポインタ。今どこまでスタックを使っているかを指す", en: "stack pointer" };
    if (isZr) return { id: "zr", ja: "常に 0 のレジスタ。書き込んでも捨てられる", en: "always zero" };
    if (num <= 7) return { id: "arg", ja: "関数の引数と戻り値に使うレジスタ（" + num + " 番目の引数）", en: "argument / return value register" };
    if (num === 8) return { id: "x8", ja: "大きな戻り値の置き場所を渡すレジスタ", en: "indirect result register" };
    if (num <= 15) return { id: "temp", ja: "自由に使える一時レジスタ。関数を呼ぶと壊れる", en: "caller-saved scratch register" };
    if (num <= 17) return { id: "ip", ja: "リンカや OS が横取りに使う一時レジスタ", en: "linker scratch register (IP0/IP1)" };
    if (num === 18) return { id: "x18", ja: "OS 用に予約されたレジスタ（iOS では触らない）", en: "platform-reserved register" };
    if (num <= 28) return { id: "saved", ja: "関数をまたいでも値が残るレジスタ（使う前に保存する約束）", en: "callee-saved register" };
    if (num === 29) return { id: "fp", ja: "フレームポインタ。今の関数のスタックの基準点", en: "frame pointer" };
    if (num === 30) return { id: "lr", ja: "戻り先アドレス。関数が終わったらここへ帰る", en: "link register — the return address" };
    return { id: "gp", ja: "汎用レジスタ", en: "general-purpose register" };
  }
  function parseReg(text) {
    const m = REG_RE.exec(text);
    if (!m) return null;
    const t = text.toLowerCase();
    if (m[1]) {
      const n = parseInt(m[2], 10);
      if (n > 31) return null;
      return { k: "reg", text: t, cls: "gp", bits: m[1].toLowerCase() === "x" ? 64 : 32, num: n };
    }
    if (m[3]) return { k: "reg", text: t, cls: "zr", bits: t[0] === "x" ? 64 : 32, num: 31 };
    if (m[4]) return { k: "reg", text: t, cls: "sp", bits: t === "sp" ? 64 : 32, num: 31 };
    if (m[5]) return { k: "reg", text: t, cls: "gp", bits: 64, num: t === "lr" ? 30 : 29 };
    if (m[6]) {
      const bits = { b: 8, h: 16, s: 32, d: 64, q: 128 }[m[6].toLowerCase()];
      return { k: "reg", text: t, cls: "fp", bits, num: parseInt(m[7], 10) };
    }
    if (m[8]) return { k: "reg", text: t, cls: "vec", bits: 128, num: parseInt(m[9], 10), arr: m[10] || null };
    return null;
  }
  var SHIFT_RE = /^(lsl|lsr|asr|ror|msl)(?:\s+#(-?(?:0x[0-9a-f]+|\d+)))?$/i;
  var EXT_RE = /^(uxtb|uxth|uxtw|uxtx|sxtb|sxth|sxtw|sxtx)(?:\s+#(-?(?:0x[0-9a-f]+|\d+)))?$/i;
  var IMM_RE = /^#(-?)(0x[0-9a-f]+|\d+(?:\.\d+)?)$/i;
  var COND_RE = /^(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv)$/i;
  var VEC_ELEM_RE = /^v(\d{1,2})\.([bhsd])\[(\d+)\]$/i;
  function splitTop(s) {
    const out = [];
    let depth = 0, cur = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function bigOf(text) {
    try {
      if (/^0x/i.test(text)) return BigInt(text);
      if (/\./.test(text)) return null;
      return BigInt(text);
    } catch {
      return null;
    }
  }
  function parseImm(text) {
    const m = IMM_RE.exec(text);
    if (!m) return null;
    const neg = m[1] === "-";
    if (/\./.test(m[2])) {
      const f = parseFloat(m[2]);
      return { k: "imm", text, value: null, float: neg ? -f : f };
    }
    const v = bigOf(m[2]);
    if (v == null) return null;
    return { k: "imm", text, value: neg ? -v : v };
  }
  function parseMem(text) {
    const bang = text.endsWith("!");
    const inner = text.replace(/^\[/, "").replace(/\]!?$/, "");
    const parts = splitTop(inner);
    if (!parts.length) return null;
    const base = parseReg(parts[0]);
    if (!base) return null;
    const mem = { k: "mem", text, base, index: null, disp: null, addressDisp: null, writebackDisp: null, shift: null, mode: bang ? "pre" : "offset" };
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const imm = parseImm(p);
      if (imm) {
        mem.disp = imm;
        mem.addressDisp = imm;
        continue;
      }
      const reg = parseReg(p);
      if (reg) {
        mem.index = reg;
        continue;
      }
      const sh = SHIFT_RE.exec(p) || EXT_RE.exec(p);
      if (sh) mem.shift = { op: sh[1].toLowerCase(), amount: sh[2] != null ? Number(bigOf(sh[2])) : null };
    }
    if (mem.mode === "pre" && mem.disp) mem.writebackDisp = mem.disp;
    return mem;
  }
  function parseOperands(str) {
    const out = [];
    if (!str) return out;
    for (const raw of splitTop(str)) {
      if (!raw) continue;
      if (raw[0] === "[") {
        const mem = parseMem(raw);
        out.push(mem || { k: "other", text: raw });
        continue;
      }
      if (raw[0] === "{") {
        const regs = splitTop(raw.replace(/^\{/, "").replace(/\}$/, "")).map((r) => parseReg(r) || { k: "other", text: r });
        out.push({ k: "list", text: raw, regs });
        continue;
      }
      const sh = SHIFT_RE.exec(raw) || EXT_RE.exec(raw);
      if (sh && out.length) {
        out[out.length - 1].shift = { op: sh[1].toLowerCase(), amount: sh[2] != null ? Number(bigOf(sh[2])) : null };
        continue;
      }
      const imm = parseImm(raw);
      if (imm) {
        out.push(imm);
        continue;
      }
      const ve = VEC_ELEM_RE.exec(raw);
      if (ve) {
        out.push({ k: "elem", text: raw, num: parseInt(ve[1], 10), size: ve[2], index: parseInt(ve[3], 10) });
        continue;
      }
      const reg = parseReg(raw);
      if (reg) {
        out.push(reg);
        continue;
      }
      if (COND_RE.test(raw)) {
        out.push({ k: "cond", text: raw.toLowerCase() });
        continue;
      }
      out.push({ k: "other", text: raw });
    }
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].k === "mem" && out[i].mode === "offset" && out[i].disp == null && out[i].index == null && out[i + 1].k === "imm" && !out[i].text.endsWith("!")) {
        out[i].writebackDisp = out[i + 1];
        out[i].addressDisp = null;
        out[i].disp = null;
        out[i].mode = "post";
        out.splice(i + 1, 1);
      }
    }
    return out;
  }
  function immText(op) {
    if (!op) return "";
    if (op.float != null) return String(op.float);
    const v = op.value;
    if (v == null) return op.text;
    const dec = v.toString(10);
    if (v > -10n && v < 10n) return dec;
    if (/^#-?0x/i.test(op.text)) {
      return isJa() ? "0x" + absHex(v) + "（10進で " + dec + "）" : "0x" + absHex(v) + " (" + dec + ")";
    }
    return dec;
  }
  function absHex(v) {
    return (v < 0n ? "-" : "") + (v < 0n ? -v : v).toString(16).toUpperCase();
  }
  function immShort(op) {
    if (!op) return "";
    if (op.float != null) return String(op.float);
    const v = op.value;
    if (v == null) return op.text.replace(/^#/, "");
    const a = v < 0n ? -v : v;
    if (a >= 0x10000n) return (v < 0n ? "-0x" : "0x") + a.toString(16).toUpperCase();
    return v.toString(10);
  }
  function shiftText(sh) {
    if (!sh) return "";
    const n = sh.amount;
    const times = n ? isJa() ? "、さらに " + 2 ** n + " 倍して" : " then ×" + 2 ** n : "";
    switch (sh.op) {
      case "lsl":
        return isJa() ? "（左へ " + n + " ビットずらす＝ " + 2 ** n + " 倍してから）" : " (shifted left by " + n + ", i.e. ×" + 2 ** n + ")";
      case "lsr":
        return isJa() ? "（右へ " + n + " ビットずらしてから）" : " (shifted right by " + n + ")";
      case "asr":
        return isJa() ? "（符号を保ったまま右へ " + n + " ビットずらしてから）" : " (arithmetic-shifted right by " + n + ")";
      case "ror":
        return isJa() ? "（" + n + " ビット回転させてから）" : " (rotated by " + n + ")";
      case "uxtb":
      case "uxth":
      case "uxtw":
      case "uxtx":
        return isJa() ? "（下半分だけ取り出して上を 0 で埋め" + times + "）" : " (zero-extended" + times + ")";
      case "sxtb":
      case "sxth":
      case "sxtw":
      case "sxtx":
        return isJa() ? "（下半分だけ取り出して符号を伸ばし" + times + "）" : " (sign-extended" + times + ")";
      default:
        return "";
    }
  }
  function shiftExpr(sh) {
    if (!sh) return "";
    const n = sh.amount;
    switch (sh.op) {
      case "lsl":
        return " << " + n;
      case "lsr":
        return " >> " + n;
      case "asr":
        return " >>a " + n;
      case "ror":
        return " ror " + n;
      default:
        return n != null ? " << " + n : "";
    }
  }
  function opShort(op) {
    if (!op) return "";
    switch (op.k) {
      case "reg":
        return op.text + (op.shift ? shiftExpr(op.shift) : "");
      case "imm":
        return immShort(op) + (op.shift ? shiftExpr(op.shift) : "");
      case "mem":
        return "[" + memExpr(op) + "]";
      case "cond":
        return op.text;
      case "list":
        return op.text;
      default:
        return op.text;
    }
  }
  function memExpr(m) {
    let s = m.base.text;
    if (m.index) s += " + " + m.index.text + (m.shift ? shiftExpr(m.shift) : "");
    else if (m.disp && m.disp.value != null && m.disp.value !== 0n && m.mode !== "post") {
      s += (m.disp.value < 0n ? " - " : " + ") + immShort({ ...m.disp, value: m.disp.value < 0n ? -m.disp.value : m.disp.value });
    }
    return s;
  }
  function memText(m) {
    const base = m.base.text;
    let where;
    const disp = m.mode === "post" ? null : m.disp;
    if (m.index) {
      where = isJa() ? base + " と " + m.index.text + shiftText(m.shift) + " を足したアドレス" : base + " + " + m.index.text;
    } else if (disp && disp.value != null && disp.value !== 0n) {
      const v = disp.value;
      const a = v < 0n ? -v : v;
      where = isJa() ? base + " から " + a.toString(10) + " バイト" + (v < 0n ? "手前" : "先") + "のアドレス" : base + (v < 0n ? " − " : " + ") + a.toString(10);
    } else {
      where = isJa() ? base + " が指しているアドレス" : "the address in " + base;
    }
    if (m.mode === "pre") {
      where += isJa() ? "（アクセスの前に " + base + " 自体もそのアドレスに書き換える）" : " (and " + base + " is updated to it first)";
    } else if (m.mode === "post") {
      const v = m.disp && m.disp.value != null ? m.disp.value : 0n;
      const a = v < 0n ? -v : v;
      where += isJa() ? "（アクセスの後で " + base + " を " + a.toString(10) + " バイト" + (v < 0n ? "戻す" : "進める") + "）" : " (then " + base + (v < 0n ? " moves back " : " advances ") + a.toString(10) + " bytes)";
    }
    return where;
  }
  var CONDS = {
    eq: { ja: "等しいとき", en: "equal", expr: "==" },
    ne: { ja: "等しくないとき", en: "not equal", expr: "!=" },
    cs: { ja: "符号なしで「以上」のとき", en: "unsigned ≥", expr: ">=u" },
    hs: { ja: "符号なしで「以上」のとき", en: "unsigned ≥", expr: ">=u" },
    cc: { ja: "符号なしで「より小さい」とき", en: "unsigned <", expr: "<u" },
    lo: { ja: "符号なしで「より小さい」とき", en: "unsigned <", expr: "<u" },
    mi: { ja: "結果がマイナスのとき", en: "negative", expr: "< 0" },
    pl: { ja: "結果が 0 以上のとき", en: "zero or positive", expr: ">= 0" },
    vs: { ja: "桁があふれたとき", en: "overflow", expr: "overflow" },
    vc: { ja: "桁があふれなかったとき", en: "no overflow", expr: "no overflow" },
    hi: { ja: "符号なしで「より大きい」とき", en: "unsigned >", expr: ">u" },
    ls: { ja: "符号なしで「以下」のとき", en: "unsigned ≤", expr: "<=u" },
    ge: { ja: "符号ありで「以上」のとき", en: "signed ≥", expr: ">=" },
    lt: { ja: "符号ありで「より小さい」とき", en: "signed <", expr: "<" },
    gt: { ja: "符号ありで「より大きい」とき", en: "signed >", expr: ">" },
    le: { ja: "符号ありで「以下」のとき", en: "signed ≤", expr: "<=" },
    al: { ja: "いつでも", en: "always", expr: "always" },
    nv: { ja: "いつでも", en: "always", expr: "always" }
  };
  function condInfo(name) {
    const c = CONDS[name];
    if (!c) return null;
    return { ja: c.ja, en: c.en, expr: c.expr, text: pick(c.ja, c.en) };
  }
  var BRANCH_IMM = /* @__PURE__ */ new Set(["b", "bl", "cbz", "cbnz", "tbz", "tbnz"]);
  function referenceTarget(mn, opsStr) {
    if (!mn) return null;
    const base = mn.toLowerCase();
    const ops = parseOperands(opsStr);
    const isCond = /^b\.[a-z]{2}$/.test(base);
    if (BRANCH_IMM.has(base) || isCond || base === "adr" || base === "adrp") {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (ops[i].k === "imm" && ops[i].value != null && ops[i].value > 0n) return ops[i].value;
      }
      return null;
    }
    if (base === "ldr" && ops.length === 2 && ops[1].k === "imm" && ops[1].value != null && ops[1].value > 0n) {
      return ops[1].value;
    }
    return null;
  }
  var CATEGORY = /* @__PURE__ */ new Map();
  function cat(names, c) {
    for (const n of names.split(" ")) CATEGORY.set(n, c);
  }
  cat("mov movz movn movk mvn fmov dup ins umov smov", "move");
  cat("add adds sub subs adc adcs sbc sbcs neg negs mul madd msub mneg smull umull smaddl umaddl smsubl umsubl smulh umulh sdiv udiv", "arith");
  cat("and ands orr orn eor eon bic bics lsl lsr asr ror lslv lsrv asrv rorv extr ubfm sbfm bfm ubfx sbfx ubfiz sbfiz bfi bfxil bfc rev rev16 rev32 rev64 clz cls rbit sxtb sxth sxtw uxtb uxth", "logic");
  cat("cmp cmn tst ccmp ccmn fcmp fcmpe", "compare");
  cat("csel csinc csinv csneg cset csetm cinc cinv cneg", "select");
  cat("ldr ldrb ldrh ldrsb ldrsh ldrsw ldur ldurb ldurh ldursb ldursh ldursw ldp ldpsw ldnp ldtr ldxr ldaxr ldar ldarb ldarh ld1 ld2 ld3 ld4 prfm", "load");
  cat("str strb strh stur sturb sturh stp stnp sttr stxr stlxr stlr stlrb stlrh st1 st2 st3 st4", "store");
  cat("b bl br blr ret cbz cbnz tbz tbnz braa brab blraa blrab retaa retab", "flow");
  cat("adr adrp", "address");
  cat("nop hint bti svc hvc smc brk hlt dmb dsb isb yield wfe wfi sev sevl mrs msr sys eret clrex paciasp pacibsp autiasp autibsp pacia pacib autia autib xpaclri pacia1716 dc ic tlbi", "system");
  cat("fadd fsub fmul fdiv fneg fabs fsqrt fmadd fmsub fnmadd fcvt fcvtzs fcvtzu fcvtas fcvtau fcvtms fcvtns fcvtps scvtf ucvtf frinta frintm frintn frintp frintz fmax fmin fmaxnm fminnm", "float");
  cat("movi mvni orr_v addv uaddlv tbl tbx zip1 zip2 uzp1 uzp2 trn1 trn2 ext rev64_v cmeq cmgt xtn sqxtn", "simd");
  cat("casal cas casa casl swp swpa swpl swpal ldadd ldadda ldaddl ldaddal ldset ldclr ldeor", "atomic");
  cat("udf .byte", "data");
  var LOAD_SIZES = {
    ldrb: [1, false],
    ldrsb: [1, true],
    ldrh: [2, false],
    ldrsh: [2, true],
    ldrsw: [4, true],
    ldurb: [1, false],
    ldursb: [1, true],
    ldurh: [2, false],
    ldursh: [2, true],
    ldursw: [4, true],
    strb: [1, false],
    strh: [2, false],
    sturb: [1, false],
    sturh: [2, false]
  };
  function sizeOfReg(r) {
    if (!r || r.k !== "reg") return 8;
    return Math.max(1, r.bits / 8);
  }
  function sizeWord(bytes) {
    if (!isJa()) return bytes + " bytes";
    const names = { 1: "1 バイト", 2: "2 バイト（16 ビット）", 4: "4 バイト（32 ビット）", 8: "8 バイト（64 ビット）", 16: "16 バイト（128 ビット）" };
    return names[bytes] || bytes + " バイト";
  }
  function J(ja, en) {
    return pick(ja, en);
  }
  function targetName(addr, c) {
    if (addr == null) return null;
    const sym = c && c.symbolFor ? c.symbolFor(addr) : null;
    const hex2 = "0x" + addr.toString(16).toUpperCase();
    return sym ? sym + "（" + hex2 + "）" : hex2;
  }
  function targetNameEn(addr, c) {
    if (addr == null) return null;
    const sym = c && c.symbolFor ? c.symbolFor(addr) : null;
    const hex2 = "0x" + addr.toString(16).toUpperCase();
    return sym ? sym + " (" + hex2 + ")" : hex2;
  }
  function tgt(addr, c) {
    return isJa() ? targetName(addr, c) : targetNameEn(addr, c);
  }
  function arith(sym, titleJa, titleEn, verbJa, verbEn, terms) {
    return (o, ops) => {
      const [d, n, m] = ops;
      o.title = J(titleJa, titleEn);
      o.pseudo = opShort(d) + " = " + opShort(n) + " " + sym + " " + opShort(m);
      o.summary = J(
        opShort(n) + " と " + opShort(m) + (m && m.shift ? shiftText(m.shift) : "") + " を" + verbJa + "、結果を " + opShort(d) + " に入れる。",
        verbEn + " " + opShort(n) + " and " + opShort(m) + ", put the result in " + opShort(d) + "."
      );
      o.terms = terms || ["register"];
    };
  }
  function withFlags(fn) {
    return (o, ops, base, addr, c) => {
      fn(o, ops, base, addr, c);
      o.detail.push(J(
        "末尾の s は「計算結果でフラグも更新する」という意味です。フラグは直後の条件分岐（b.eq など）が見ます。",
        "The trailing “s” also updates the condition flags, which the next conditional branch reads."
      ));
      o.terms.push("flags");
    };
  }
  var HANDLERS = /* @__PURE__ */ Object.create(null);
  HANDLERS.mov = (o, ops) => {
    const [d, s] = ops;
    o.title = J("代入", "Move");
    o.pseudo = opShort(d) + " = " + opShort(s);
    if (s && s.k === "elem") {
      o.summary = J(
        "ベクタレジスタ v" + s.num + " の " + s.index + " 番目の枠だけを取り出して " + opShort(d) + " に入れる。",
        "Take lane " + s.index + " of v" + s.num + " into " + opShort(d) + "."
      );
      o.detail.push(J(
        "ベクタレジスタは 16 バイトを何個かの「枠」に区切って使います。その中の 1 枠だけを普通のレジスタへ移す命令です。",
        "A vector register is divided into lanes; this moves one lane into a general-purpose register."
      ));
      o.terms = ["simd"];
      return;
    }
    if (d && d.k === "elem") {
      o.summary = J(
        opShort(s) + " を、ベクタレジスタ v" + d.num + " の " + d.index + " 番目の枠に入れる。",
        "Put " + opShort(s) + " into lane " + d.index + " of v" + d.num + "."
      );
      o.terms = ["simd"];
      return;
    }
    if (s && s.k === "imm") {
      o.summary = J(
        opShort(d) + " に " + immText(s) + " を入れる。",
        "Put " + immText(s) + " into " + opShort(d) + "."
      );
      o.detail.push(J(
        "アセンブリでは「変数に代入する」がこの形になります。# が付いている値は、命令そのものに埋め込まれた定数です。",
        "This is what “assign a constant to a variable” looks like. The # value is baked into the instruction itself."
      ));
      o.terms = ["register", "immediate"];
    } else if (d && s && d.cls === "gp" && d.num === 29 && s.cls === "sp") {
      o.title = J("この関数の基準点を決める", "Set up the frame pointer");
      o.summary = J(
        "今のスタックの位置を x29 に控える。ここから先、ローカル変数の場所は x29 を基準に数えられます。",
        "Record the current stack position in x29 — locals are addressed relative to it from here on."
      );
      o.detail.push(J(
        "関数の入り口で stp のすぐ後にこれが来るのが定番です。この 2 行が見えたら「新しい関数が始まった」と読めます。x29 をたどると「どの関数がどの関数を呼んだか」が分かるので、クラッシュログの呼び出し履歴はこれで作られます。",
        "The standard second line of a prologue. Chained x29 values are what a crash log’s backtrace walks."
      ));
      o.terms = ["framepointer", "prologue", "stack"];
    } else {
      o.summary = J(
        opShort(s) + " の中身を " + opShort(d) + " へコピーする。" + opShort(s) + " は変わらない。",
        "Copy " + opShort(s) + " into " + opShort(d) + ". " + opShort(s) + " is unchanged."
      );
      o.terms = ["register"];
    }
    addRegRoles(o, ops);
  };
  HANDLERS.movz = (o, ops) => {
    const [d, s] = ops;
    o.title = J("代入（上を 0 で埋める）", "Move with zero");
    o.pseudo = opShort(d) + " = " + opShort(s);
    o.summary = J(
      opShort(d) + " に " + immText(s) + " を入れ、残りのビットは全部 0 にする。",
      "Set " + opShort(d) + " to " + immText(s) + ", zeroing every other bit."
    );
    o.detail.push(J(
      "ARM64 の命令は 4 バイトしかないので、64 ビットの大きな定数は一度に書き込めません。そこで movz で下 16 ビットを置き、movk で 16 ビットずつ足していきます。",
      "An ARM64 instruction is only 4 bytes, so a 64-bit constant is built 16 bits at a time: movz then movk."
    ));
    o.terms = ["immediate", "register"];
  };
  HANDLERS.movk = (o, ops) => {
    const [d, s] = ops;
    const sh = s && s.shift ? s.shift.amount : 0;
    o.title = J("定数を 16 ビットだけ差し替える", "Move keeping other bits");
    o.pseudo = opShort(d) + "[" + (sh + 15) + ":" + sh + "] = " + immShort(s);
    o.summary = J(
      opShort(d) + " の " + sh + " ビット目から 16 ビット分だけを " + immText(s) + " に書き換える。他のビットはそのまま。",
      "Replace 16 bits of " + opShort(d) + " starting at bit " + sh + " with " + immText(s) + "; the rest is kept."
    );
    o.detail.push(J(
      "大きな定数（アドレスなど）を movz → movk → movk … と 16 ビットずつ組み立てている途中です。数行まとめて 1 つの数だと思って読んでください。",
      "Part of building a large constant 16 bits at a time. Read the movz/movk run as one value."
    ));
    o.terms = ["immediate"];
  };
  HANDLERS.movn = (o, ops) => {
    const [d, s] = ops;
    o.title = J("ビットを反転して代入", "Move NOT");
    o.pseudo = opShort(d) + " = ~" + opShort(s);
    o.summary = J(
      immText(s) + " の 0 と 1 をすべてひっくり返した値を " + opShort(d) + " に入れる。−1 などの負の数を作るのに使います。",
      "Put the bitwise inverse of " + immText(s) + " into " + opShort(d) + " — how small negative constants are made."
    );
    o.terms = ["immediate", "twoscomplement"];
  };
  HANDLERS.mvn = (o, ops) => {
    const [d, s] = ops;
    o.title = J("ビット反転", "Bitwise NOT");
    o.pseudo = opShort(d) + " = ~" + opShort(s);
    o.summary = J(
      opShort(s) + " の 0 と 1 をすべて入れ替えて " + opShort(d) + " に入れる。",
      "Flip every bit of " + opShort(s) + " into " + opShort(d) + "."
    );
    o.terms = ["bitwise"];
  };
  HANDLERS.add = (o, ops, base, addr, c) => {
    const [d, n, m] = ops;
    o.title = J("足し算", "Add");
    o.pseudo = opShort(d) + " = " + opShort(n) + " + " + opShort(m);
    o.summary = J(
      opShort(n) + " に " + (m && m.k === "imm" ? immText(m) : opShort(m)) + (m && m.shift ? shiftText(m.shift) : "") + " を足して " + opShort(d) + " に入れる。",
      "Add " + opShort(m) + " to " + opShort(n) + ", result in " + opShort(d) + "."
    );
    o.terms = ["register"];
    if (n && n.cls === "sp" && d && d.cls === "gp" && d.num === 29) {
      o.detail.push(J(
        "x29（フレームポインタ）にスタックの位置を控えています。関数の入り口でよく見る形です。",
        "Recording the stack position in x29 (the frame pointer) — a standard function prologue step."
      ));
      o.terms.push("framepointer");
    }
    if (d && n && d.text === n.text && m && m.k === "imm") {
      o.detail.push(J(
        "同じレジスタに足し戻しているので、C 言語で書けば " + opShort(d) + " += " + immShort(m) + "; です。",
        "Same register on both sides — in C this is " + opShort(d) + " += " + immShort(m) + ";"
      ));
    }
    if (c && c.prev && /^adrp$/i.test(c.prev.mn) && m && m.k === "imm") {
      const page = referenceTarget("adrp", c.prev.ops);
      if (page != null) {
        const full = page + (m.value || 0n);
        o.target = full;
        o.detail.push(J(
          "1 行上の adrp と組で、" + tgt(full, c) + " というアドレスを作っています。ARM64 で遠くのデータを指すときの定番の 2 行です。",
          "Together with the adrp above, this builds the address " + tgt(full, c) + " — the standard ARM64 pair for reaching distant data."
        ));
        o.terms.push("adrp");
      }
    }
    addRegRoles(o, ops);
  };
  HANDLERS.adds = withFlags(HANDLERS.add);
  HANDLERS.sub = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("引き算", "Subtract");
    o.pseudo = opShort(d) + " = " + opShort(n) + " − " + opShort(m);
    o.summary = J(
      opShort(n) + " から " + (m && m.k === "imm" ? immText(m) : opShort(m)) + " を引いて " + opShort(d) + " に入れる。",
      "Subtract " + opShort(m) + " from " + opShort(n) + ", result in " + opShort(d) + "."
    );
    o.terms = ["register"];
    if (d && n && d.cls === "sp" && n.cls === "sp" && m && m.k === "imm") {
      o.title = J("スタックの場所を確保する", "Reserve stack space");
      o.summary = J(
        "スタックポインタを " + (m.value || 0n).toString(10) + " バイト下げて、その分の作業スペースを確保する。",
        "Lower the stack pointer by " + m.value + " bytes to make room for local variables."
      );
      o.detail.push(J(
        "スタックはアドレスが小さい方へ伸びるので、「引く」＝「場所を取る」です。関数の終わりでは同じ量を add sp, sp, #… で返します。",
        "The stack grows downwards, so subtracting reserves space. The epilogue adds the same amount back."
      ));
      o.terms = ["stack", "sp"];
    }
    addRegRoles(o, ops);
  };
  HANDLERS.subs = withFlags(HANDLERS.sub);
  HANDLERS.adc = arith("+", "足し算（繰り上がり込み）", "Add with carry", "繰り上がりも含めて足し", "Add with carry");
  HANDLERS.sbc = arith("−", "引き算（借り込み）", "Subtract with carry", "借りも含めて引き", "Subtract with borrow");
  HANDLERS.neg = (o, ops) => {
    const [d, s] = ops;
    o.title = J("符号を反転", "Negate");
    o.pseudo = opShort(d) + " = −" + opShort(s);
    o.summary = J(
      opShort(s) + " のプラスマイナスを反転して " + opShort(d) + " に入れる。",
      "Flip the sign of " + opShort(s) + " into " + opShort(d) + "."
    );
    o.terms = ["twoscomplement"];
  };
  HANDLERS.mul = arith("×", "掛け算", "Multiply", "かけ", "Multiply");
  HANDLERS.sdiv = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("割り算（符号あり）", "Signed divide");
    o.pseudo = opShort(d) + " = " + opShort(n) + " ÷ " + opShort(m);
    o.summary = J(
      opShort(n) + " を " + opShort(m) + " で割った商（小数は切り捨て）を " + opShort(d) + " に入れる。マイナスも扱えます。",
      "Divide " + opShort(n) + " by " + opShort(m) + " (truncating), signed."
    );
    o.detail.push(J("0 で割っても例外にはならず、結果は 0 になります。", "Dividing by zero yields 0 rather than trapping."));
  };
  HANDLERS.udiv = (o, ops) => {
    HANDLERS.sdiv(o, ops);
    o.title = J("割り算（符号なし）", "Unsigned divide");
    o.summary = o.summary.replace(J("マイナスも扱えます。", ""), J("マイナスは扱いません（全部プラスとして計算）。", ""));
  };
  HANDLERS.madd = (o, ops) => {
    const [d, n, m, a] = ops;
    o.title = J("掛けて足す", "Multiply-add");
    o.pseudo = opShort(d) + " = " + opShort(a) + " + " + opShort(n) + " × " + opShort(m);
    o.summary = J(
      opShort(n) + " × " + opShort(m) + " を計算し、それに " + opShort(a) + " を足して " + opShort(d) + " に入れる。",
      "Multiply then add, all in one instruction."
    );
    o.detail.push(J("配列の添字計算（base + index × サイズ）でよく出てきます。", "Common in array index arithmetic."));
  };
  HANDLERS.msub = (o, ops) => {
    const [d, n, m, a] = ops;
    o.title = J("掛けて引く", "Multiply-subtract");
    o.pseudo = opShort(d) + " = " + opShort(a) + " − " + opShort(n) + " × " + opShort(m);
    o.summary = J(
      opShort(a) + " から " + opShort(n) + " × " + opShort(m) + " を引いて " + opShort(d) + " に入れる。",
      "Multiply then subtract."
    );
    o.detail.push(J("割り算のあとに「余り」を求める形（a − (a÷b)×b）でよく出ます。", "Often computes a remainder after a division."));
  };
  HANDLERS.smull = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("32ビット同士を掛けて64ビットに", "Signed long multiply");
    o.pseudo = opShort(d) + " = " + opShort(n) + " × " + opShort(m);
    o.summary = J(
      "32 ビットの " + opShort(n) + " と " + opShort(m) + " を掛け、あふれないように 64 ビットの " + opShort(d) + " に入れる。",
      "Multiply two 32-bit values into a 64-bit result."
    );
  };
  HANDLERS.umull = HANDLERS.smull;
  HANDLERS.and = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("ビットの AND", "Bitwise AND");
    o.pseudo = opShort(d) + " = " + opShort(n) + " & " + opShort(m);
    o.summary = J(
      opShort(n) + " と " + opShort(m) + " の両方で 1 のビットだけを残して " + opShort(d) + " に入れる。",
      "Keep only the bits set in both, into " + opShort(d) + "."
    );
    if (m && m.k === "imm") {
      o.detail.push(J(
        "定数との AND は「必要な部分だけ取り出す」ためのマスクです。例えば & 0xFF なら下 1 バイトだけを残します。",
        "ANDing with a constant masks out everything but the bits you want."
      ));
    }
    o.terms = ["bitwise", "mask"];
  };
  HANDLERS.ands = withFlags(HANDLERS.and);
  HANDLERS.orr = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("ビットの OR", "Bitwise OR");
    o.pseudo = opShort(d) + " = " + opShort(n) + " | " + opShort(m);
    o.summary = J(
      opShort(n) + " と " + opShort(m) + " のどちらかで 1 のビットを 1 にして " + opShort(d) + " に入れる。",
      "Set the bits present in either operand."
    );
    o.detail.push(J("「フラグを立てる」ときの定番です。", "The usual way to turn flag bits on."));
    o.terms = ["bitwise"];
  };
  HANDLERS.eor = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("ビットの XOR", "Bitwise XOR");
    o.pseudo = opShort(d) + " = " + opShort(n) + " ^ " + opShort(m);
    o.summary = J(
      opShort(n) + " と " + opShort(m) + " で「片方だけ 1」のビットを 1 にして " + opShort(d) + " に入れる。",
      "Set the bits that differ between the two."
    );
    if (n && m && n.text === m.text) {
      o.detail.push(J(
        "同じ値どうしの XOR は必ず 0 です。つまりこれは " + opShort(d) + " を 0 にする書き方です。",
        "XOR with itself is always zero — this is a way of writing " + opShort(d) + " = 0."
      ));
    }
    o.detail.push(J("暗号やハッシュの処理でも頻繁に出てきます。", "Very common in crypto and hashing code."));
    o.terms = ["bitwise"];
  };
  HANDLERS.bic = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("ビットを落とす", "Bit clear");
    o.pseudo = opShort(d) + " = " + opShort(n) + " & ~" + opShort(m);
    o.summary = J(
      opShort(m) + " で 1 になっているビットを " + opShort(n) + " から消して " + opShort(d) + " に入れる。",
      "Clear the bits of " + opShort(n) + " that are set in " + opShort(m) + "."
    );
    o.terms = ["bitwise"];
  };
  HANDLERS.orn = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("反転して OR", "OR NOT");
    o.pseudo = opShort(d) + " = " + opShort(n) + " | ~" + opShort(m);
    o.summary = J(opShort(m) + " を反転してから " + opShort(n) + " と OR する。", "OR with the inverse.");
  };
  HANDLERS.eon = (o, ops) => {
    const [d, n, m] = ops;
    o.title = J("反転して XOR", "XOR NOT");
    o.pseudo = opShort(d) + " = " + opShort(n) + " ^ ~" + opShort(m);
    o.summary = J(opShort(m) + " を反転してから XOR する。", "XOR with the inverse.");
  };
  function shifter(titleJa, titleEn, verbJa, verbEn, symbol, note) {
    return (o, ops) => {
      const [d, n, m] = ops;
      o.title = J(titleJa, titleEn);
      o.pseudo = opShort(d) + " = " + opShort(n) + " " + symbol + " " + opShort(m);
      const amount = m && m.k === "imm" ? m.value == null ? null : m.value : null;
      const howMany = amount != null ? amount.toString(10) + " ビット" : opShort(m) + " ビット";
      o.summary = J(
        opShort(n) + " のビット全体を " + howMany + verbJa + "、結果を " + opShort(d) + " に入れる。",
        verbEn + " " + opShort(n) + " by " + opShort(m) + " into " + opShort(d) + "."
      );
      if (amount != null && amount > 0n && amount < 64n && note) o.detail.push(note(amount));
      o.terms = ["bitwise", "shift"];
    };
  }
  HANDLERS.lsl = shifter("ビットを左へずらす", "Shift left", "左へずらして", "Shift left", "<<", (n) => J(
    "左に " + n + " ビットずらすのは、2 の " + n + " 乗（" + (2n ** n).toString(10) + "）を掛けるのと同じです。掛け算より速いので、コンパイラは「× 2」「× 8」をこの形に置き換えます。",
    "Shifting left by " + n + " multiplies by " + 2n ** n + " — cheaper than a multiply, so the compiler prefers it."
  ));
  HANDLERS.lsr = shifter("ビットを右へずらす", "Shift right", "右へずらして", "Shift right", ">>", (n) => J(
    "右に " + n + " ビットずらすのは、2 の " + n + " 乗（" + (2n ** n).toString(10) + "）で割るのと同じです（余りは切り捨て）。空いた上位ビットには 0 が入ります。",
    "Shifting right by " + n + " divides by " + 2n ** n + ", discarding the remainder; zeros fill in at the top."
  ));
  HANDLERS.asr = shifter("ビットを右へずらす（符号を保つ）", "Arithmetic shift right", "符号を保ったまま右へずらして", "Arithmetic-shift right", ">>", () => J(
    "空いた上位ビットに、元の符号ビット（一番上のビット）と同じ値を詰めます。こうするとマイナスの数もマイナスのまま割り算できます。",
    "The vacated top bits are filled with the sign bit, so negative values divide correctly."
  ));
  HANDLERS.ror = shifter("ビットを回転させる", "Rotate right", "回転させて", "Rotate", "ror", () => J(
    "端からこぼれたビットが反対側から戻ってくる「回転」です。値のビットは 1 つも失われません。ハッシュや暗号の計算でよく使われます。",
    "Bits that fall off one end reappear at the other — nothing is lost. Common in hashing and crypto."
  ));
  HANDLERS.ubfx = (o, ops) => {
    const [d, n, lsb, width] = ops;
    o.title = J("ビットを切り出す", "Extract bit field");
    o.pseudo = opShort(d) + " = (" + opShort(n) + " >> " + immShort(lsb) + ") & " + (width && width.value != null ? "0x" + ((1n << width.value) - 1n).toString(16).toUpperCase() : "…");
    o.summary = J(
      opShort(n) + " の " + immShort(lsb) + " ビット目から " + immShort(width) + " ビット分を抜き出して " + opShort(d) + " に入れる。上は 0 で埋める。",
      "Take " + immShort(width) + " bits starting at bit " + immShort(lsb) + " of " + opShort(n) + "."
    );
    o.detail.push(J("1 個の数の中に複数の情報を詰め込んでいるときの取り出しです。", "Unpacking several fields stored in one word."));
    o.terms = ["bitfield"];
  };
  HANDLERS.sbfx = (o, ops) => {
    HANDLERS.ubfx(o, ops);
    o.title = J("ビットを切り出す（符号つき）", "Extract signed bit field");
  };
  HANDLERS.ubfiz = (o, ops) => {
    const [d, n, lsb, width] = ops;
    o.title = J("切り出して左に置く", "Insert bit field");
    o.pseudo = opShort(d) + " = (" + opShort(n) + " & mask) << " + immShort(lsb);
    o.summary = J(
      opShort(n) + " の下 " + immShort(width) + " ビットを取り、" + immShort(lsb) + " ビット目の位置に置いて " + opShort(d) + " に入れる。",
      "Take the low bits and place them at bit " + immShort(lsb) + "."
    );
    o.terms = ["bitfield"];
  };
  HANDLERS.sbfiz = HANDLERS.ubfiz;
  HANDLERS.bfi = (o, ops) => {
    const [d, n, lsb, width] = ops;
    o.title = J("ビットを差し込む", "Bit field insert");
    o.pseudo = opShort(d) + "[" + immShort(lsb) + "…] = " + opShort(n);
    o.summary = J(
      opShort(n) + " の下 " + immShort(width) + " ビットを、" + opShort(d) + " の " + immShort(lsb) + " ビット目に埋め込む。他はそのまま。",
      "Insert bits of " + opShort(n) + " into " + opShort(d) + " without touching the rest."
    );
    o.terms = ["bitfield"];
  };
  HANDLERS.bfxil = HANDLERS.bfi;
  HANDLERS.extr = (o, ops) => {
    const [d, n, m, lsb] = ops;
    o.title = J("2 つをつないで切り出す", "Extract from pair");
    o.pseudo = opShort(d) + " = concat(" + opShort(n) + ", " + opShort(m) + ") >> " + immShort(lsb);
    o.summary = J(
      opShort(n) + " と " + opShort(m) + " を横に並べた長いビット列から、" + immShort(lsb) + " ビット目以降を切り出す。",
      "Concatenate the two registers and take a window out of the middle."
    );
  };
  HANDLERS.rev = (o, ops) => {
    const [d, s] = ops;
    o.title = J("バイトの順番を逆に", "Reverse bytes");
    o.pseudo = opShort(d) + " = byteswap(" + opShort(s) + ")";
    o.summary = J(
      opShort(s) + " のバイトの並びを前後ひっくり返して " + opShort(d) + " に入れる。",
      "Reverse the byte order of " + opShort(s) + "."
    );
    o.detail.push(J(
      "ネットワークのデータは「大きい桁が先」（ビッグエンディアン）、ARM は「小さい桁が先」（リトルエンディアン）なので、変換にこれを使います。",
      "Network data is big-endian while ARM is little-endian, so byte swapping converts between them."
    ));
    o.terms = ["endian"];
  };
  HANDLERS.rev16 = HANDLERS.rev;
  HANDLERS.rev32 = HANDLERS.rev;
  HANDLERS.clz = (o, ops) => {
    const [d, s] = ops;
    o.title = J("先頭に並ぶ 0 を数える", "Count leading zeros");
    o.pseudo = opShort(d) + " = clz(" + opShort(s) + ")";
    o.summary = J(
      opShort(s) + " を 2 進数で書いたとき、頭にいくつ 0 が続くかを数えて " + opShort(d) + " に入れる。",
      "Count the zero bits before the first 1."
    );
    o.detail.push(J("「この数は何桁必要か」を高速に求めるのに使われます。", "A fast way to ask how many bits a value needs."));
  };
  HANDLERS.rbit = (o, ops) => {
    const [d, s] = ops;
    o.title = J("ビットの並びを逆に", "Reverse bits");
    o.pseudo = opShort(d) + " = bitreverse(" + opShort(s) + ")";
    o.summary = J(opShort(s) + " のビットを前後ひっくり返して " + opShort(d) + " に入れる。", "Reverse the bit order.");
  };
  function extend(bytes, signed) {
    return (o, ops) => {
      const [d, s] = ops;
      o.title = signed ? J("符号を伸ばして拡張", "Sign extend") : J("0 を詰めて拡張", "Zero extend");
      o.pseudo = opShort(d) + " = " + (signed ? "(signed)" : "(unsigned)") + opShort(s);
      o.summary = signed ? J(
        opShort(s) + " の下 " + bytes * 8 + " ビットを取り出し、マイナスならマイナスのまま大きい幅にして " + opShort(d) + " に入れる。",
        "Take the low " + bytes * 8 + " bits and widen them, keeping the sign."
      ) : J(
        opShort(s) + " の下 " + bytes * 8 + " ビットを取り出し、上を 0 で埋めて " + opShort(d) + " に入れる。",
        "Take the low " + bytes * 8 + " bits and zero the rest."
      );
      o.detail.push(J(
        "C 言語で char や short を int に代入したときに、コンパイラがここを入れます。",
        "What the compiler emits when a char or short is assigned to an int."
      ));
      o.terms = ["signedness"];
    };
  }
  HANDLERS.sxtb = extend(1, true);
  HANDLERS.sxth = extend(2, true);
  HANDLERS.sxtw = extend(4, true);
  HANDLERS.uxtb = extend(1, false);
  HANDLERS.uxth = extend(2, false);
  HANDLERS.cmp = (o, ops) => {
    const [n, m] = ops;
    o.title = J("比べる", "Compare");
    o.pseudo = "flags = " + opShort(n) + " − " + opShort(m);
    o.summary = J(
      opShort(n) + " と " + (m && m.k === "imm" ? immText(m) : opShort(m)) + " を比べる。結果はレジスタには残らず、フラグにだけ残る。",
      "Compare " + opShort(n) + " with " + opShort(m) + ". The result only updates the flags."
    );
    o.detail.push(J(
      "実際には引き算をして、答えは捨て、「0 だったか」「マイナスだったか」だけを覚えます。その直後の b.eq / b.lt などが、その覚えた結果を見て進む先を決めます。つまり cmp と分岐は必ずセットで読みます。",
      "It subtracts, throws the result away and keeps only the flags. The following b.eq / b.lt reads them — always read the pair together."
    ));
    o.terms = ["flags", "branch"];
  };
  HANDLERS.cmn = (o, ops) => {
    const [n, m] = ops;
    o.title = J("足した結果で比べる", "Compare negative");
    o.pseudo = "flags = " + opShort(n) + " + " + opShort(m);
    o.summary = J(
      opShort(n) + " に " + opShort(m) + " を足した結果でフラグを立てる。「−N と比べる」ときに使われます。",
      "Adds instead of subtracting; used to compare against a negative number."
    );
    o.terms = ["flags"];
  };
  HANDLERS.tst = (o, ops) => {
    const [n, m] = ops;
    o.title = J("ビットが立っているか調べる", "Test bits");
    o.pseudo = "flags = " + opShort(n) + " & " + opShort(m);
    o.summary = J(
      opShort(n) + " の中で " + opShort(m) + " が示すビットが 1 かどうかを調べる。結果はフラグにだけ残る。",
      "AND the two and keep only the flags — “is this bit set?”."
    );
    o.detail.push(J(
      "直後が b.eq なら「そのビットが 0 だったら飛ぶ」、b.ne なら「1 だったら飛ぶ」です。",
      "A following b.eq means “the bit was clear”; b.ne means “it was set”."
    ));
    o.terms = ["flags", "mask"];
  };
  HANDLERS.ccmp = (o, ops) => {
    const [n, m, nzcv, cond] = ops;
    const ci = cond ? condInfo(cond.text) : null;
    o.title = J("条件つきで比べる", "Conditional compare");
    o.pseudo = "if (" + (cond ? cond.text : "?") + ") flags = " + opShort(n) + " − " + opShort(m) + " else flags = " + immShort(nzcv);
    o.summary = J(
      "前の比較が「" + (ci ? ci.ja : "条件を満たしたとき") + "」に当てはまる場合だけ、" + opShort(n) + " と " + opShort(m) + " をもう一度比べる。当てはまらなければフラグを " + immShort(nzcv) + " に決め打ちする。",
      "Compare again only if the previous condition held; otherwise force the flags to " + immShort(nzcv) + "."
    );
    o.detail.push(J(
      "C 言語の && や || を、分岐を増やさずに 1 本にまとめた形です（if (a == 1 && b == 2) など）。",
      "How && and || are compiled without extra branches."
    ));
    o.terms = ["flags"];
  };
  HANDLERS.ccmn = HANDLERS.ccmp;
  HANDLERS.csel = (o, ops) => {
    const [d, n, m, cond] = ops;
    const ci = cond ? condInfo(cond.text) : null;
    o.title = J("条件で選ぶ", "Conditional select");
    o.pseudo = opShort(d) + " = " + (cond ? cond.text : "?") + " ? " + opShort(n) + " : " + opShort(m);
    o.summary = J(
      "直前の比較が「" + (ci ? ci.ja : cond && cond.text) + "」なら " + opShort(n) + "、そうでなければ " + opShort(m) + " を " + opShort(d) + " に入れる。",
      "Put " + opShort(n) + " in " + opShort(d) + " if " + (ci ? ci.en : "") + ", otherwise " + opShort(m) + "."
    );
    o.detail.push(J(
      "C 言語の三項演算子 a = cond ? b : c と同じです。分岐しないので速く、条件によって実行時間が変わらないため暗号処理でも好まれます。",
      "The ternary operator, without a branch."
    ));
    o.terms = ["flags"];
  };
  HANDLERS.csinc = (o, ops) => {
    const [d, n, m, cond] = ops;
    const ci = cond ? condInfo(cond.text) : null;
    o.title = J("条件で選ぶ（片方は +1）", "Conditional select increment");
    o.pseudo = opShort(d) + " = " + (cond ? cond.text : "?") + " ? " + opShort(n) + " : " + opShort(m) + " + 1";
    o.summary = J(
      "「" + (ci ? ci.ja : "") + "」なら " + opShort(n) + "、違えば " + opShort(m) + " に 1 を足した値を " + opShort(d) + " に入れる。",
      "Select, adding one to the second choice."
    );
    o.terms = ["flags"];
  };
  HANDLERS.csinv = HANDLERS.csinc;
  HANDLERS.csneg = HANDLERS.csinc;
  HANDLERS.cset = (o, ops) => {
    const [d, cond] = ops;
    const ci = cond ? condInfo(cond.text) : null;
    o.title = J("条件を 0 か 1 にする", "Set to 0 or 1");
    o.pseudo = opShort(d) + " = (" + (ci ? ci.expr : cond && cond.text) + ") ? 1 : 0";
    o.summary = J(
      "直前の比較が「" + (ci ? ci.ja : "") + "」なら " + opShort(d) + " に 1、そうでなければ 0 を入れる。",
      "Set " + opShort(d) + " to 1 when " + (ci ? ci.en : "") + ", else 0."
    );
    o.detail.push(J(
      "C 言語で bool result = (a == b); と書いたときの形です。",
      "What “bool r = (a == b);” compiles to."
    ));
    o.terms = ["flags"];
  };
  HANDLERS.csetm = (o, ops) => {
    const [d, cond] = ops;
    const ci = cond ? condInfo(cond.text) : null;
    o.title = J("条件を 0 か「全ビット 1」にする", "Set to 0 or all-ones");
    o.pseudo = opShort(d) + " = (" + (ci ? ci.expr : cond && cond.text) + ") ? -1 : 0";
    o.summary = J(
      "直前の比較が「" + (ci ? ci.ja : "") + "」なら " + opShort(d) + " を全ビット 1（＝ −1）に、そうでなければ 0 にする。",
      "Set " + opShort(d) + " to all-ones (−1) when " + (ci ? ci.en : "") + ", else 0."
    );
    o.detail.push(J(
      "全ビット 1 は、そのあと AND で使う「マスク」として便利なので、分岐なしで値を選ぶ書き方に使われます。",
      "All-ones makes a handy mask for a following AND — a branch-free way to select a value."
    ));
    o.terms = ["flags", "mask"];
  };
  HANDLERS.cinc = (o, ops) => {
    const [d, n, cond] = ops;
    const ci = cond ? condInfo(cond.text) : null;
    o.title = J("条件が合えば +1", "Conditional increment");
    o.pseudo = opShort(d) + " = " + (cond ? cond.text : "?") + " ? " + opShort(n) + " + 1 : " + opShort(n);
    o.summary = J(
      "「" + (ci ? ci.ja : "") + "」なら " + opShort(n) + " に 1 を足して、違えばそのまま " + opShort(d) + " に入れる。",
      "Add one only if the condition holds."
    );
    o.terms = ["flags"];
  };
  HANDLERS.cinv = HANDLERS.cinc;
  HANDLERS.cneg = HANDLERS.cinc;
  function loadStore(isLoad) {
    return (o, ops, base, addr, c) => {
      const dst = ops[0];
      const mem = ops.find((x) => x.k === "mem");
      const size = LOAD_SIZES[base] ? LOAD_SIZES[base][0] : sizeOfReg(dst);
      const signed = LOAD_SIZES[base] ? LOAD_SIZES[base][1] : false;
      o.title = isLoad ? J("メモリから読む", "Load from memory") : J("メモリへ書く", "Store to memory");
      if (!mem) {
        o.pseudo = (mn2(base) || base) + " " + (o.operands || "");
        return;
      }
      o.pseudo = isLoad ? opShort(dst) + " = *(" + cType(size, signed) + "*)(" + memExpr(mem) + ")" : "*(" + cType(size, signed) + "*)(" + memExpr(mem) + ") = " + opShort(dst);
      o.summary = isLoad ? J(
        memText(mem) + "から " + sizeWord(size) + " 読み込み、" + opShort(dst) + " に入れる。",
        "Read " + sizeWord(size) + " from " + memText(mem) + " into " + opShort(dst) + "."
      ) : J(
        opShort(dst) + " の値（" + sizeWord(size) + "）を、" + memText(mem) + "へ書き込む。",
        "Write " + sizeWord(size) + " from " + opShort(dst) + " to " + memText(mem) + "."
      );
      o.detail.push(J(
        "レジスタは 31 本しかないので、それより多くのデータはメモリに置きます。メモリを使うにはこのように「アドレスを作って、読む／書く」の 2 段構えになります。",
        "There are only 31 registers, so everything else lives in memory: build an address, then load or store."
      ));
      if (signed) {
        o.detail.push(J(
          "s が付いているので、読んだ値がマイナスならマイナスのまま大きい幅に伸ばします。",
          "The “s” means the value is sign-extended as it is widened."
        ));
        o.terms.push("signedness");
      }
      if (mem.base && mem.base.cls === "sp") {
        o.detail.push(isLoad ? J(
          "sp からの読み込みなので、この関数のローカル変数（一時的な変数）を読んでいます。",
          "Reading from sp — this is a local variable of the current function."
        ) : J(
          "sp への書き込みなので、この関数のローカル変数に値をしまっています。",
          "Writing to sp — storing into a local variable."
        ));
        o.terms.push("stack");
      }
      if (mem.mode === "pre" || mem.mode === "post") {
        o.detail.push(J(
          "アドレスを計算するついでに " + mem.base.text + " 自体も進める書き方です。配列を 1 つずつ舐めるループでよく出ます。",
          "The base register is updated as a side effect — typical of a loop walking an array."
        ));
      }
      o.terms.push("memory", "address");
      addRegRoles(o, ops);
    };
  }
  function mn2(x) {
    return x;
  }
  function cType(size, signed) {
    const t = { 1: "int8", 2: "int16", 4: "int32", 8: "int64", 16: "int128" }[size] || "int" + size * 8;
    return (signed ? "" : "u") + t;
  }
  for (const n of ["ldr", "ldrb", "ldrh", "ldrsb", "ldrsh", "ldrsw", "ldur", "ldurb", "ldurh", "ldursb", "ldursh", "ldursw", "ldtr", "ldar", "ldarb", "ldarh", "ldxr", "ldaxr"]) {
    HANDLERS[n] = loadStore(true);
  }
  for (const n of ["str", "strb", "strh", "stur", "sturb", "sturh", "sttr", "stlr", "stlrb", "stlrh"]) {
    HANDLERS[n] = loadStore(false);
  }
  var plainLdr = HANDLERS.ldr;
  HANDLERS.ldr = (o, ops, base, addr, c) => {
    if (ops.length === 2 && ops[1].k === "imm" && ops[1].value != null) {
      const at = ops[1].value;
      o.title = J("近くに置かれた定数を読む", "Load from a literal pool");
      o.pseudo = opShort(ops[0]) + " = *(uint64*)0x" + at.toString(16).toUpperCase();
      o.summary = J(
        "この命令の近くに埋め込まれている値（" + tgt(at, c) + " の場所）を読み込んで " + opShort(ops[0]) + " に入れる。",
        "Read the constant stored at " + tgt(at, c) + " into " + opShort(ops[0]) + "."
      );
      o.detail.push(J(
        "命令には大きな数をそのまま書けないので、コンパイラはコードのすぐ近くに数を置いて、こうして読み出します。そこは命令ではなくデータなので、逆アセンブルすると意味不明な行に見えます。",
        "Large constants cannot fit in an instruction, so they are parked next to the code and loaded from there. That area is data, not code, and looks like nonsense when disassembled."
      ));
      o.target = at;
      o.terms = ["literalpool", "memory"];
      return;
    }
    plainLdr(o, ops, base, addr, c);
  };
  function pairLoadStore(isLoad) {
    return (o, ops, base, addr, c) => {
      const [a, b] = ops;
      const mem = ops.find((x) => x.k === "mem");
      const size = sizeOfReg(a);
      o.title = isLoad ? J("2 本まとめて読む", "Load a pair") : J("2 本まとめて書く", "Store a pair");
      if (!mem) return;
      o.pseudo = isLoad ? opShort(a) + ", " + opShort(b) + " = *(pair*)(" + memExpr(mem) + ")" : "*(pair*)(" + memExpr(mem) + ") = " + opShort(a) + ", " + opShort(b);
      o.summary = isLoad ? J(
        memText(mem) + "から " + sizeWord(size) + " ずつ 2 個読み、" + opShort(a) + " と " + opShort(b) + " に入れる。",
        "Read two values into " + opShort(a) + " and " + opShort(b) + "."
      ) : J(
        opShort(a) + " と " + opShort(b) + " を、" + memText(mem) + "から順に 2 個ぶん書き込む。",
        "Write " + opShort(a) + " and " + opShort(b) + " side by side."
      );
      o.detail.push(J(
        "2 本を 1 命令で扱えるので、関数の入口と出口でレジスタを退避／復元するときの定番です。",
        "Two registers in one instruction — the standard way to save and restore around a function."
      ));
      const isFpLr = a && b && a.num === 29 && b.num === 30;
      const onStack = mem.base && mem.base.cls === "sp";
      const dispVal = mem.disp && mem.disp.value != null ? mem.disp.value : 0n;
      if (onStack && mem.mode === "pre" && dispVal < 0n && !isLoad) {
        o.title = J("スタックへ積む（push）", "Push onto the stack");
        o.summary = J(
          "スタックを " + (-dispVal).toString(10) + " バイト広げて、その先頭に " + opShort(a) + " と " + opShort(b) + " を置く。",
          "Grow the stack by " + -dispVal + " bytes and put " + opShort(a) + " and " + opShort(b) + " there."
        );
      } else if (onStack && mem.mode === "post" && dispVal > 0n && isLoad) {
        o.title = J("スタックから降ろす（pop）", "Pop from the stack");
        o.summary = J(
          "スタックの先頭から " + opShort(a) + " と " + opShort(b) + " を取り戻し、スタックを " + dispVal.toString(10) + " バイト縮める。",
          "Take " + opShort(a) + " and " + opShort(b) + " back off the stack and shrink it by " + dispVal + " bytes."
        );
      }
      if (isFpLr && !isLoad) {
        o.title = J("関数の入り口（今の場所を保存）", "Function prologue");
        o.summary = J(
          "戻り先アドレス (x30) と、呼び出し元のフレーム位置 (x29) をスタックに保存する。関数の始まりの合図です。",
          "Save the return address and the caller’s frame pointer — the start of a function."
        );
        o.detail.push(J(
          "これをやらないと、別の関数を呼んだ瞬間に「どこへ帰ればいいか」を忘れてしまいます。関数の終わりでは ldp で逆に取り出します。",
          "Without this, calling another function would destroy the return address. The epilogue restores it with ldp."
        ));
        o.terms.push("prologue", "lr", "stack");
      } else if (isFpLr && isLoad) {
        o.title = J("関数の出口（元に戻す）", "Function epilogue");
        o.summary = J(
          "スタックに預けておいた戻り先アドレス (x30) とフレーム位置 (x29) を取り戻す。もうすぐ ret で帰ります。",
          "Restore the saved return address and frame pointer — a ret is coming."
        );
        o.terms.push("epilogue", "lr", "stack");
      } else if (a && a.num >= 19 && a.num <= 28) {
        o.detail.push(isLoad ? J(
          "x19〜x28 は「呼ばれた側が元に戻す約束」のレジスタです。ここで戻しています。",
          "x19–x28 are callee-saved; this restores them."
        ) : J(
          "x19〜x28 は「呼ばれた側が元に戻す約束」のレジスタなので、使う前に預けています。",
          "x19–x28 are callee-saved, so they are stashed before use."
        ));
        o.terms.push("calleesaved");
      }
      o.terms.push("stack", "memory");
    };
  }
  HANDLERS.stp = pairLoadStore(false);
  HANDLERS.stnp = pairLoadStore(false);
  HANDLERS.ldp = pairLoadStore(true);
  HANDLERS.ldnp = pairLoadStore(true);
  HANDLERS.ldpsw = pairLoadStore(true);
  HANDLERS.prfm = (o, ops) => {
    const mem = ops.find((x) => x.k === "mem");
    o.title = J("先に読み込ませておく", "Prefetch");
    o.pseudo = "prefetch(" + (mem ? memExpr(mem) : "") + ")";
    o.summary = J(
      "あとで使うデータを、CPU に「そろそろ用意しておいて」と伝える。値は何も変わりません。",
      "Hint to the CPU to fetch this memory early. Nothing changes."
    );
    o.detail.push(J("速度のためだけの命令なので、動きを読むときは無視して構いません。", "Purely a performance hint — safe to ignore when reading logic."));
  };
  HANDLERS.adr = (o, ops, base, addr, c) => {
    const [d, imm] = ops;
    const at = imm && imm.value;
    o.title = J("近くのアドレスを作る", "Address of nearby");
    o.pseudo = opShort(d) + " = 0x" + (at != null ? at.toString(16).toUpperCase() : "?");
    o.summary = J(
      opShort(d) + " に " + tgt(at, c) + " というアドレスそのものを入れる（中身は読まない）。",
      "Put the address " + tgt(at, c) + " itself into " + opShort(d) + " (no memory is read)."
    );
    o.target = at;
    o.terms = ["address", "pcrelative"];
  };
  HANDLERS.adrp = (o, ops, base, addr, c) => {
    const [d, imm] = ops;
    const at = imm && imm.value;
    o.title = J("遠くのアドレスの「ページ」を作る", "Address of a 4 KB page");
    o.pseudo = opShort(d) + " = 0x" + (at != null ? at.toString(16).toUpperCase() : "?");
    o.summary = J(
      opShort(d) + " に " + tgt(at, c) + " を入れる。これは 4096 バイト単位に切り下げた「おおまかな住所」です。",
      "Put " + tgt(at, c) + " — a 4 KB-aligned page address — into " + opShort(d) + "."
    );
    o.detail.push(J(
      "4 バイトの命令 1 つでは遠い場所を指せないので、まず adrp でおおまかな位置を作り、次の行の add または ldr で細かい位置を足します。この 2 行はセットで 1 つのアドレスだと思ってください。",
      "One 4-byte instruction cannot hold a far address, so adrp gives the page and the next add/ldr adds the offset. Read the two lines as one address."
    ));
    o.target = at;
    o.terms = ["address", "adrp", "pcrelative"];
  };
  HANDLERS.b = (o, ops, base, addr, c) => {
    const at = ops[0] && ops[0].value;
    o.title = J("ジャンプ", "Branch");
    o.pseudo = "goto 0x" + (at != null ? at.toString(16).toUpperCase() : "?");
    const dir = at != null && addr != null ? at < addr ? J("前（上）", "backwards") : J("後ろ（下）", "forwards") : "";
    o.summary = J(
      "無条件で " + tgt(at, c) + " へ飛ぶ。ここから下の行は（飛んでこない限り）実行されません。",
      "Jump to " + tgt(at, c) + " unconditionally."
    );
    if (at != null && addr != null && at < addr) {
      o.detail.push(J(
        "飛び先が今より前なので、ループの終わりでしょう。同じところを繰り返しています。",
        "The target is earlier than here, so this is the bottom of a loop."
      ));
      o.terms.push("loop");
    } else {
      o.detail.push(J(
        "飛び先が今より後ろなので、if 文の「else を飛ばす」ような使い方でしょう。",
        "The target is later — typically skipping over an else block."
      ));
    }
    o.target = at;
    o.terms.push("branch");
  };
  HANDLERS.bl = (o, ops, base, addr, c) => {
    const at = ops[0] && ops[0].value;
    const sym = at != null && c && c.symbolFor ? c.symbolFor(at) : null;
    o.title = J("関数を呼ぶ", "Call a function");
    o.pseudo = (sym ? sym : "0x" + (at != null ? at.toString(16).toUpperCase() : "?")) + "()";
    o.summary = sym ? J(
      sym + " を呼び出す。終わったらこの次の行に戻ってきます。",
      "Call " + sym + "; execution returns to the next line."
    ) : J(
      tgt(at, c) + " にある関数を呼び出す。終わったらこの次の行に戻ってきます。",
      "Call the function at " + tgt(at, c) + "; execution returns to the next line."
    );
    o.detail.push(J(
      "bl は「飛ぶ前に、次の行のアドレスを x30 (lr) にメモしてから飛ぶ」命令です。呼ばれた側は最後に ret でその x30 へ帰ってきます。これが関数呼び出しの正体です。",
      "bl records the address of the following instruction in x30 (lr) before jumping; the callee returns to it with ret. That is all a function call is."
    ));
    o.detail.push(J(
      "引数は x0、x1、x2… の順に入れて渡し、戻り値は x0 で受け取ります。この行の少し上を見ると、x0 などに値を入れている行があるはずです。それが引数です。",
      "Arguments go in x0, x1, x2 … and the result comes back in x0. Look just above for the lines that set them."
    ));
    o.target = at;
    o.terms = ["call", "lr", "abi"];
  };
  HANDLERS.blr = (o, ops) => {
    const r = ops[0];
    o.title = J("レジスタの指す関数を呼ぶ", "Call through a register");
    o.pseudo = "(*" + opShort(r) + ")()";
    o.summary = J(
      opShort(r) + " に入っているアドレスの関数を呼ぶ。どこへ行くかは実行してみないと分かりません。",
      "Call whatever address is in " + opShort(r) + ". The target is only known at run time."
    );
    o.detail.push(J(
      "関数ポインタ、Objective-C のメソッド呼び出し、仮想関数などがこの形になります。「どの関数か」を知るには、少し上で " + opShort(r) + " に何を入れているかを追いかけます。",
      "Function pointers, Objective-C message sends and C++ virtual calls all look like this. Trace what fills " + opShort(r) + "."
    ));
    o.terms = ["call", "indirect"];
  };
  HANDLERS.br = (o, ops) => {
    const r = ops[0];
    o.title = J("レジスタの指す先へ飛ぶ", "Jump through a register");
    o.pseudo = "goto *" + opShort(r);
    o.summary = J(
      opShort(r) + " の中のアドレスへ飛ぶ。戻ってきません。",
      "Jump to the address in " + opShort(r) + " and do not come back."
    );
    o.detail.push(J(
      "switch 文の飛び先表や、ライブラリ関数への中継（スタブ）でよく出ます。",
      "Common in switch jump tables and in stubs that forward to library functions."
    ));
    o.terms = ["indirect"];
  };
  HANDLERS.ret = (o, ops) => {
    const r = ops && ops[0] && ops[0].k === "reg" ? ops[0].text : "x30";
    o.title = J("関数から帰る", "Return");
    o.pseudo = "return";
    o.summary = J(
      r + (r === "x30" ? " (lr)" : "") + " に入っている「戻り先アドレス」へジャンプして、呼び出し元に帰る。ここでこの関数は終わりです。",
      "Jump to the return address held in " + r + ". This is the end of the function."
    );
    o.detail.push(J(
      "戻り値があるなら x0（32 ビットなら w0）に入っています。この行の少し上で x0 に何を入れたかを見てください。",
      "A return value, if any, is already in x0 / w0 — look at the lines just above."
    ));
    o.terms = ["lr", "abi", "epilogue"];
  };
  HANDLERS.retaa = HANDLERS.ret;
  HANDLERS.retab = HANDLERS.ret;
  function cbzHandler(zero) {
    return (o, ops, base, addr, c) => {
      const [r, immOp] = ops;
      const at = immOp && immOp.value;
      o.title = zero ? J("0 なら飛ぶ", "Branch if zero") : J("0 でなければ飛ぶ", "Branch if not zero");
      o.pseudo = "if (" + opShort(r) + (zero ? " == 0" : " != 0") + ") goto 0x" + (at != null ? at.toString(16).toUpperCase() : "?");
      o.summary = J(
        opShort(r) + " が " + (zero ? "0 なら" : "0 以外なら") + " " + tgt(at, c) + " へ飛ぶ。違えば次の行へ。",
        "Jump to " + tgt(at, c) + " when " + opShort(r) + (zero ? " is zero" : " is not zero") + "."
      );
      o.detail.push(J(
        "cmp を書かずに、レジスタが 0 かどうかだけをその場で見る短縮形です。C 言語の if (p == NULL) や if (n) がよくこの形になります。",
        "A shortcut that tests for zero without a separate compare — “if (p == NULL)” and “if (n)” compile to this."
      ));
      if (at != null && addr != null && at < addr) {
        o.terms.push("loop");
      }
      o.target = at;
      o.terms.push("branch");
    };
  }
  HANDLERS.cbz = cbzHandler(true);
  HANDLERS.cbnz = cbzHandler(false);
  function tbzHandler(zero) {
    return (o, ops, base, addr, c) => {
      const [r, bit, immOp] = ops;
      const at = immOp && immOp.value;
      const n = bit && bit.value != null ? bit.value.toString(10) : "?";
      const nth = bit && bit.value != null ? "（一番下を 0 として数えて " + (bit.value + 1n).toString(10) + " 個目）" : "";
      o.title = zero ? J("そのビットが 0 なら飛ぶ", "Branch if bit clear") : J("そのビットが 1 なら飛ぶ", "Branch if bit set");
      o.pseudo = "if ((" + opShort(r) + " >> " + n + " & 1)" + (zero ? " == 0" : " == 1") + ") goto 0x" + (at != null ? at.toString(16).toUpperCase() : "?");
      o.summary = J(
        opShort(r) + " のビット " + n + nth + " が " + (zero ? "0" : "1") + " なら " + tgt(at, c) + " へ飛ぶ。",
        "Jump when bit " + n + " of " + opShort(r) + " is " + (zero ? "clear" : "set") + "."
      );
      if (bit && bit.value != null && (bit.value === 63n || bit.value === 31n)) {
        o.detail.push(J(
          "一番上のビットは符号ビットなので、これは実質「マイナスかどうか」の判定です。",
          "The top bit is the sign bit, so this is really a “is it negative?” test."
        ));
      }
      o.detail.push(J(
        "フラグ（設定のオンオフ）を 1 ビットずつ詰めた値の判定でよく出ます。",
        "Common when several boolean flags are packed into one value."
      ));
      o.target = at;
      o.terms.push("branch", "bitwise");
    };
  }
  HANDLERS.tbz = tbzHandler(true);
  HANDLERS.tbnz = tbzHandler(false);
  HANDLERS.nop = (o) => {
    o.title = J("何もしない", "No operation");
    o.pseudo = "/* 何もしない */";
    o.summary = J(
      "文字どおり何もしません。位置合わせや、後で書き換えるための場所取りに使われます。",
      "Does nothing. Used for alignment or as a placeholder to patch later."
    );
  };
  HANDLERS.svc = (o, ops) => {
    o.title = J("OS に仕事を頼む", "System call");
    o.pseudo = "syscall()";
    o.summary = J(
      "CPU から OS（カーネル）へ切り替えて、ファイルを開くなどの処理を頼む。",
      "Switch to the kernel and ask the OS to do something — open a file, and so on."
    );
    o.detail.push(J(
      "アプリが自分だけでできない仕事（ファイル、ネットワーク、画面）は、必ずここを通って OS に頼みます。どの仕事を頼むかは x16 に入っている番号で決まります。",
      "Anything an app cannot do alone goes through here; the request number is in x16."
    ));
    o.terms = ["syscall"];
  };
  HANDLERS.brk = (o) => {
    o.title = J("わざと止める", "Breakpoint / trap");
    o.pseudo = "trap()";
    o.summary = J(
      "その場でプログラムを停止させます。デバッガ用、または「ここには来ないはず」という保険です。",
      "Halts the program — used by debuggers, or as an “unreachable” guard."
    );
    o.detail.push(J(
      "Swift の配列範囲外アクセスや、整数のあふれ検出で、この命令に飛ばされてクラッシュします。",
      "Swift traps such as array-out-of-bounds land here."
    ));
  };
  HANDLERS.udf = HANDLERS.brk;
  HANDLERS.bti = (o) => {
    o.title = J("ここへの飛び込みを許可する目印", "Branch target marker");
    o.pseudo = "/* 飛び込み可 */";
    o.summary = J(
      "「ここは正規のジャンプ先です」という目印。攻撃者が変な場所へ飛ぶのを防ぐ仕組みです。",
      "Marks a legitimate branch target, so an attacker cannot jump into the middle of code."
    );
    o.terms = ["security"];
  };
  HANDLERS.hint = HANDLERS.bti;
  for (const n of ["paciasp", "pacibsp", "pacia", "pacib"]) {
    HANDLERS[n] = (o) => {
      o.title = J("戻り先アドレスに封をする", "Sign the return address");
      o.pseudo = "lr = sign(lr)";
      o.summary = J(
        "戻り先アドレス (x30) に、書き換えを検出するための「封印」を付ける。",
        "Add a cryptographic signature to the return address in x30."
      );
      o.detail.push(J(
        "スタックを壊して戻り先を書き換える攻撃（ROP）を防ぐ仕組みです。関数の入口で封をし、出口で autiasp が確認します。書き換えられていたらクラッシュします。arm64e（新しい iPhone）でよく見ます。",
        "Pointer authentication: the prologue signs the return address and the epilogue checks it, defeating ROP attacks."
      ));
      o.terms = ["pac", "security", "lr"];
    };
  }
  for (const n of ["autiasp", "autibsp", "autia", "autib", "xpaclri"]) {
    HANDLERS[n] = (o) => {
      o.title = J("戻り先アドレスの封を確かめる", "Verify the return address");
      o.pseudo = "lr = verify(lr)";
      o.summary = J(
        "入口で付けた封印を確認して外す。壊されていればここでクラッシュします。",
        "Check and strip the signature added in the prologue; a tampered value crashes here."
      );
      o.terms = ["pac", "security", "lr"];
    };
  }
  for (const n of ["dmb", "dsb", "isb"]) {
    HANDLERS[n] = (o) => {
      o.title = J("順番を守らせる", "Memory barrier");
      o.pseudo = "barrier()";
      o.summary = J(
        "CPU が勝手に順番を入れ替えないよう、ここで一度そろえる。",
        "Stop the CPU from reordering memory operations across this point."
      );
      o.detail.push(J(
        "CPU は速度のために命令の順番を入れ替えます。複数のスレッドが同じデータを触るときは、それが困るのでここで止めます。",
        "CPUs reorder for speed; with multiple threads that is unsafe, so this pins the order."
      ));
      o.terms = ["thread"];
    };
  }
  HANDLERS.mrs = (o, ops) => {
    o.title = J("CPU の特別なレジスタを読む", "Read a system register");
    o.pseudo = opShort(ops[0]) + " = " + (ops[1] ? ops[1].text : "");
    o.summary = J(
      "CPU 内部の特別な値（スレッド固有の領域、時刻など）を読み出して " + opShort(ops[0]) + " に入れる。",
      "Read a special CPU register into " + opShort(ops[0]) + "."
    );
  };
  HANDLERS.msr = (o, ops) => {
    o.title = J("CPU の特別なレジスタに書く", "Write a system register");
    o.pseudo = (ops[0] ? ops[0].text : "") + " = " + opShort(ops[1]);
    o.summary = J("CPU 内部の特別な設定を書き換える。", "Write a special CPU register.");
  };
  HANDLERS.fmov = (o, ops) => {
    const [d, s] = ops;
    o.title = J("小数レジスタへの代入", "Move (floating point)");
    o.pseudo = opShort(d) + " = " + opShort(s);
    o.summary = J(
      opShort(s) + " を " + opShort(d) + " へそのままコピーする（値の形は変えない）。",
      "Copy the bits from " + opShort(s) + " to " + opShort(d) + " unchanged."
    );
    o.detail.push(J(
      "d0〜d31 や s0〜s31 は、小数（浮動小数点数）専用のレジスタです。x0 などとは別に用意されています。",
      "d0–d31 and s0–s31 are separate registers used for floating-point values."
    ));
    o.terms = ["float"];
  };
  function fbin(sym, ja, en) {
    return (o, ops) => {
      const [d, n, m] = ops;
      o.title = J("小数の" + ja, en);
      o.pseudo = opShort(d) + " = " + opShort(n) + " " + sym + " " + opShort(m);
      o.summary = J(
        opShort(n) + " と " + opShort(m) + " を小数として" + ja + "、" + opShort(d) + " に入れる。",
        en + " as floating point."
      );
      o.terms = ["float"];
    };
  }
  HANDLERS.fadd = fbin("+", "足し算", "Float add");
  HANDLERS.fsub = fbin("−", "引き算", "Float subtract");
  HANDLERS.fmul = fbin("×", "掛け算", "Float multiply");
  HANDLERS.fdiv = fbin("÷", "割り算", "Float divide");
  HANDLERS.fcmp = (o, ops) => {
    const [n, m] = ops;
    o.title = J("小数を比べる", "Float compare");
    o.pseudo = "flags = " + opShort(n) + " ⋛ " + opShort(m);
    o.summary = J(
      opShort(n) + " と " + opShort(m) + " を小数として比べ、結果をフラグに残す。",
      "Compare two floating-point values, updating the flags."
    );
    o.terms = ["float", "flags"];
  };
  for (const n of ["fcvtzs", "fcvtzu", "fcvtas", "fcvtau", "fcvtms", "fcvtns", "fcvtps"]) {
    HANDLERS[n] = (o, ops) => {
      o.title = J("小数を整数にする", "Float to integer");
      o.pseudo = opShort(ops[0]) + " = (int)" + opShort(ops[1]);
      o.summary = J(
        opShort(ops[1]) + " の小数を整数に変換して " + opShort(ops[0]) + " に入れる（小数点以下は切り捨て）。",
        "Convert the float in " + opShort(ops[1]) + " to an integer."
      );
      o.terms = ["float"];
    };
  }
  for (const n of ["scvtf", "ucvtf"]) {
    HANDLERS[n] = (o, ops) => {
      o.title = J("整数を小数にする", "Integer to float");
      o.pseudo = opShort(ops[0]) + " = (double)" + opShort(ops[1]);
      o.summary = J(
        opShort(ops[1]) + " の整数を小数の形に変換して " + opShort(ops[0]) + " に入れる。",
        "Convert the integer in " + opShort(ops[1]) + " to floating point."
      );
      o.terms = ["float"];
    };
  }
  HANDLERS.fcvt = (o, ops) => {
    o.title = J("小数の精度を変える", "Convert float precision");
    o.pseudo = opShort(ops[0]) + " = (" + (ops[0] && ops[0].bits === 64 ? "double" : "float") + ")" + opShort(ops[1]);
    o.summary = J("小数の桁数（精度）を変換する。", "Change between float and double precision.");
    o.terms = ["float"];
  };
  HANDLERS.movi = (o, ops) => {
    o.title = J("まとめて同じ値を入れる", "Fill a vector");
    o.pseudo = opShort(ops[0]) + " = { " + immShort(ops[1]) + ", … }";
    o.summary = J(
      "ベクタレジスタ " + opShort(ops[0]) + " の全部の枠に " + immText(ops[1]) + " を入れる。",
      "Set every lane of " + opShort(ops[0]) + " to " + immText(ops[1]) + "."
    );
    o.detail.push(J(
      "v0〜v31 は 16 バイトを一度に扱えるレジスタです。memset や画像処理でまとめて処理するのに使われます。",
      "v0–v31 hold 16 bytes at once; used for memset, image and audio work."
    ));
    o.terms = ["simd"];
  };
  HANDLERS.dup = (o, ops) => {
    o.title = J("同じ値を並べる", "Duplicate into all lanes");
    o.pseudo = opShort(ops[0]) + " = { " + opShort(ops[1]) + " × n }";
    o.summary = J(
      opShort(ops[1]) + " の値を " + opShort(ops[0]) + " の全部の枠にコピーする。",
      "Copy " + opShort(ops[1]) + " into every lane."
    );
    o.terms = ["simd"];
  };
  for (const n of ["ld1", "ld2", "ld3", "ld4"]) {
    HANDLERS[n] = (o, ops) => {
      const mem = ops.find((x) => x.k === "mem");
      o.title = J("まとめて読む（16 バイト単位）", "Vector load");
      o.pseudo = (ops[0] ? ops[0].text : "") + " = *(vector*)(" + (mem ? memExpr(mem) : "") + ")";
      o.summary = J(
        mem ? memText(mem) + "から 16 バイト単位でまとめて読み込む。" : "まとめて読み込む。",
        "Load a whole vector at once."
      );
      o.terms = ["simd", "memory"];
    };
  }
  for (const n of ["st1", "st2", "st3", "st4"]) {
    HANDLERS[n] = (o, ops) => {
      const mem = ops.find((x) => x.k === "mem");
      o.title = J("まとめて書く（16 バイト単位）", "Vector store");
      o.pseudo = "*(vector*)(" + (mem ? memExpr(mem) : "") + ") = " + (ops[0] ? ops[0].text : "");
      o.summary = J(
        mem ? memText(mem) + "へ 16 バイト単位でまとめて書き込む。" : "まとめて書き込む。",
        "Store a whole vector at once."
      );
      o.terms = ["simd", "memory"];
    };
  }
  for (const n of ["ldxr", "ldaxr"]) {
    HANDLERS[n] = (o, ops) => {
      const mem = ops.find((x) => x.k === "mem");
      o.title = J("横取りされないように読む", "Exclusive load");
      o.pseudo = opShort(ops[0]) + " = *(" + (mem ? memExpr(mem) : "") + ") /* 監視開始 */";
      o.summary = J(
        "メモリを読むと同時に「ここを見張る」と CPU に宣言する。他のスレッドが書き換えたら、次の stxr が失敗します。",
        "Load and start watching the address; a matching stxr fails if anyone else writes it."
      );
      o.detail.push(J(
        "複数のスレッドが同じ値を同時に増やそうとしても壊れないように、read → 変更 → write を「誰にも割り込まれずに」行うための仕組みです。",
        "The building block of atomic read-modify-write across threads."
      ));
      o.terms = ["thread", "atomic"];
    };
  }
  for (const n of ["stxr", "stlxr"]) {
    HANDLERS[n] = (o, ops) => {
      const mem = ops.find((x) => x.k === "mem");
      o.title = J("横取りされていなければ書く", "Exclusive store");
      o.pseudo = opShort(ops[0]) + " = try_store(" + (mem ? memExpr(mem) : "") + ", " + opShort(ops[1]) + ")";
      o.summary = J(
        "見張っていた間に誰も書き換えていなければ書き込み、" + opShort(ops[0]) + " に 0（成功）を入れる。失敗なら 1 が入り、ふつうは上に戻ってやり直します。",
        "Store only if nothing else wrote the address; " + opShort(ops[0]) + " gets 0 on success, 1 on failure."
      );
      o.terms = ["thread", "atomic"];
    };
  }
  for (const n of ["casal", "cas", "casa", "casl"]) {
    HANDLERS[n] = (o, ops) => {
      const mem = ops.find((x) => x.k === "mem");
      o.title = J("比べて、合っていれば入れ替える", "Compare and swap");
      o.pseudo = "if (*" + (mem ? memExpr(mem) : "") + " == " + opShort(ops[0]) + ") *… = " + opShort(ops[1]);
      o.summary = J(
        "メモリの中身が期待どおりならすげ替える。1 命令で安全に行える「読んで書く」です。",
        "Atomically swap the value only if it still matches what was expected."
      );
      o.terms = ["thread", "atomic"];
    };
  }
  for (const n of ["ldadd", "ldadda", "ldaddl", "ldaddal", "ldset", "ldclr", "ldeor", "swp", "swpa", "swpl", "swpal"]) {
    HANDLERS[n] = (o, ops) => {
      const mem = ops.find((x) => x.k === "mem");
      o.title = J("割り込まれずに読み書きする", "Atomic read-modify-write");
      o.pseudo = opShort(ops[1]) + " = atomic(" + (mem ? memExpr(mem) : "") + ", " + opShort(ops[0]) + ")";
      o.summary = J(
        "他のスレッドに邪魔されずに、メモリの値を読んで書き換える。参照カウントの増減などで使われます。",
        "Read and update memory without another thread getting in between — reference counting, for example."
      );
      o.terms = ["thread", "atomic"];
    };
  }
  HANDLERS[".byte"] = (o, ops, base, addr, c) => {
    o.title = J("命令ではなくデータ", "Data, not code");
    o.pseudo = "/* " + (o.operands || "") + " */";
    o.summary = J(
      "この 4 バイトは CPU の命令として意味を持ちません。文字列、数値、アドレスなどのデータが置かれている場所です。",
      "These 4 bytes are not a valid instruction — this is data: a string, a number or an address."
    );
    o.detail.push(J(
      "プログラムの中には、コードとデータが混ざって置かれています。ここを「16進」タブで見ると、右側に文字として読める部分があるかもしれません。",
      "Code and data are interleaved. Switch to the Hex tab — the ASCII column may show readable text."
    ));
    o.category = "data";
    o.terms = ["data"];
  };
  function addRegRoles(o, ops) {
    const seen = /* @__PURE__ */ new Set();
    for (const op of ops) {
      const regs = op.k === "reg" ? [op] : op.k === "mem" ? [op.base, op.index].filter(Boolean) : [];
      for (const r of regs) {
        if (!r || r.cls === "fp" || r.cls === "vec") continue;
        if (seen.has(r.text)) continue;
        seen.add(r.text);
        const role = registerRole(r.num, r.cls === "sp", r.cls === "zr");
        if (role.id === "lr") o.terms.push("lr");
        if (role.id === "fp") o.terms.push("framepointer");
        if (role.id === "sp") o.terms.push("sp");
      }
    }
  }

  // js/patch.js
  var CONDS2 = ["eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al", "nv"];
  function assemble(text, at) {
    const src = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!src) return { error: "命令が空です。" };
    const sp = src.indexOf(" ");
    const mn = sp < 0 ? src : src.slice(0, sp);
    const rest = sp < 0 ? "" : src.slice(sp + 1);
    const ops = parseOperands(rest);
    if (mn === "nop") return word(3573751839);
    if (mn === "ret") return word(3596551104);
    if (mn === "brk") {
      const imm = immOf(ops[0]);
      if (imm == null || imm < 0n || imm > 0xFFFFn) return { error: "brk の値は 0〜0xFFFF です。" };
      return word(3558866944 | Number(imm) << 5);
    }
    if (mn === "mov" || mn === "movz") {
      const dst = regInfo(ops[0]);
      const d = dst && dst.num;
      const imm = immOf(ops[1]);
      if (d == null) return { error: "書き込み先のレジスタが読めません。" };
      if (imm != null) {
        if (imm < 0n || imm > 0xFFFFn) return { error: "この簡易アセンブラでは 0〜65535 の値だけ書けます。" };
        if (dst.sp) return { error: "SP へ即値を直接 mov することはできません。" };
        const sf2 = dst.bits === 64 ? 1 : 0;
        return word(sf2 << 31 | 165 << 23 | Number(imm) << 5 | d);
      }
      const srcReg = regInfo(ops[1]);
      const m = srcReg && srcReg.num;
      if (m == null) return { error: "mov の右側が読めません。" };
      if (dst.bits !== srcReg.bits) return { error: "mov の左右は同じ幅（w同士 / x同士）で指定してください。" };
      const sf = dst.bits === 64 ? 1 : 0;
      if (dst.sp || srcReg.sp) {
        if (dst.zr || srcReg.zr) return { error: "SP と ZR の間は mov できません。" };
        return word(sf << 31 | 285212672 | m << 5 | d);
      }
      return word(sf << 31 | 336 << 21 | m << 16 | 31 << 5 | d);
    }
    if (mn === "b" || mn === "bl") {
      const target = immOf(ops[0]);
      if (target == null) return { error: "飛び先のアドレスが読めません（0x… の形で書いてください）。" };
      if ((target - at) % 4n !== 0n) return { error: "飛び先は 4 バイト境界で指定してください。" };
      const delta = (target - at) / 4n;
      if (delta < -(1n << 25n) || delta >= 1n << 25n) return { error: "飛び先が遠すぎます（±128 MB まで）。" };
      return word((mn === "bl" ? 1 : 0) << 31 | 5 << 26 | Number(BigInt.asUintN(26, delta)));
    }
    const bc = /^b\.(\w+)$/.exec(mn);
    if (bc) {
      const cond = CONDS2.indexOf(bc[1]);
      if (cond < 0) return { error: "知らない条件です: " + bc[1] };
      const target = immOf(ops[0]);
      if (target == null) return { error: "飛び先のアドレスが読めません。" };
      if ((target - at) % 4n !== 0n) return { error: "飛び先は 4 バイト境界で指定してください。" };
      const delta = (target - at) / 4n;
      if (delta < -(1n << 18n) || delta >= 1n << 18n) return { error: "条件分岐の飛び先が遠すぎます（±1 MB まで）。" };
      return word(84 << 24 | Number(BigInt.asUintN(19, delta)) << 5 | cond);
    }
    return { error: "この簡易アセンブラは " + mn + " に対応していません。16 進で直接指定してください。" };
  }
  function word(v) {
    const out = new Uint8Array(4);
    out[0] = v & 255;
    out[1] = v >>> 8 & 255;
    out[2] = v >>> 16 & 255;
    out[3] = v >>> 24 & 255;
    return { bytes: out };
  }
  function regNum(op) {
    if (!op || op.k !== "reg") return null;
    if (op.cls === "zr" || op.cls === "sp") return 31;
    if (op.cls !== "gp") return null;
    return op.num;
  }
  function regInfo(op) {
    const num = regNum(op);
    if (num == null) return null;
    return { num, bits: op.bits === 32 ? 32 : 64, sp: op.cls === "sp", zr: op.cls === "zr" };
  }
  function immOf(op) {
    if (!op) return null;
    if (op.k === "imm") return op.value;
    if (op.k === "other" && /^0x[0-9a-f]+$/.test(op.text)) return BigInt(op.text);
    return null;
  }

  // js/architecture/index.js
  var BUILTINS = /* @__PURE__ */ new Map();
  function canonicalId(value) {
    return String(value || "").trim().toLowerCase();
  }
  function positiveInteger(value, name, { nullable = false } = {}) {
    if (nullable && value == null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new TypeError(`${name} must be a finite positive integer`);
    return n;
  }
  var ArchitectureAdapter = class {
    constructor(definition) {
      const id = canonicalId(definition?.id);
      if (!id) throw new TypeError("architecture id is required");
      this.id = id;
      this.instructionAlignment = positiveInteger(definition.instructionAlignment ?? 1, "instructionAlignment");
      this.fixedInstructionSize = positiveInteger(definition.fixedInstructionSize, "fixedInstructionSize", { nullable: true });
      this.viewerCompatible = !!definition.viewerCompatible;
      this.decode = definition.decode || null;
      this.assemble = definition.assemble || null;
      this.controlFlow = definition.controlFlow || (() => null);
      this.callKind = definition.callKind || (() => null);
      this.returnKind = definition.returnKind || (() => null);
      this.rowForAddress = definition.rowForAddress || ((region, address) => {
        if (this.fixedInstructionSize == null || !region) return null;
        const rel = BigInt(address) - BigInt(region.vmAddr);
        if (rel < 0n || rel >= BigInt(region.size)) return null;
        const size = BigInt(this.fixedInstructionSize);
        if (rel % size !== 0n) return null;
        return Number(rel / size);
      });
      this.addressForRow = definition.addressForRow || ((region, row) => {
        if (this.fixedInstructionSize == null || !region) return null;
        const n = Number(row);
        if (!Number.isSafeInteger(n) || n < 0) return null;
        const address = BigInt(region.vmAddr) + BigInt(n) * BigInt(this.fixedInstructionSize);
        return address < BigInt(region.vmAddr) + BigInt(region.size) ? address : null;
      });
      this.validateInstructionPlacement = definition.validateInstructionPlacement || ((region, address, length) => {
        if (this.fixedInstructionSize == null) return unsupportedArchitectureResult("assemble", this.id);
        const rel = BigInt(address) - BigInt(region?.vmAddr ?? 0n);
        if (!region || rel < 0n || rel >= BigInt(region.size)) return { ok: false, code: "patch-range", error: "アドレスがコードのセクション範囲外です。" };
        if (rel % BigInt(this.instructionAlignment) !== 0n || Number(length) !== this.fixedInstructionSize) {
          return { ok: false, code: "instruction-placement", architecture: this.id, error: `${this.id} 命令の位置または長さが不正です。` };
        }
        return { ok: true };
      });
      Object.freeze(this);
    }
  };
  var UnsupportedArchitectureError = class extends Error {
    constructor(operation, architecture) {
      super(`${operation} is not supported for architecture ${architecture || "unknown"}`);
      this.name = "UnsupportedArchitectureError";
      this.code = "unsupported-architecture";
      this.unsupported = true;
      this.operation = operation;
      this.architecture = canonicalId(architecture || "unknown");
    }
  };
  function unsupportedArchitectureResult(operation, architecture) {
    const error = new UnsupportedArchitectureError(operation, architecture);
    return {
      ok: false,
      unsupported: true,
      code: error.code,
      operation: error.operation,
      architecture: error.architecture,
      error: error.message
    };
  }
  function registerArchitectureAdapter(definition, { replace = false } = {}) {
    const adapter = definition instanceof ArchitectureAdapter ? definition : new ArchitectureAdapter(definition);
    const id = canonicalId(adapter.id);
    if (BUILTINS.has(id) && !replace) throw new Error(`architecture already registered: ${id}`);
    BUILTINS.set(id, adapter);
    return adapter;
  }
  function architectureAdapter(id) {
    return BUILTINS.get(canonicalId(id)) || BUILTINS.get("unknown");
  }
  function architectureCapability(image2, engine = {}) {
    const architecture = canonicalId(image2?.arch || "unknown");
    const adapter = architectureAdapter(architecture);
    const engineSupported = !!engine[architecture] || architecture === "arm64e" && !!engine.arm64;
    const arm64Analysis = (architecture === "arm64" || architecture === "arm64e") && engineSupported;
    const emulationSupported = !!engine.emulation?.[architecture];
    const analysisLevel = arm64Analysis ? architecture === "arm64e" ? "partial" : "full" : "unsupported";
    return Object.freeze({
      format: image2?.format || "unknown",
      architecture,
      endianness: image2?.endian || "unknown",
      bits: Number(image2?.bits || 0),
      canDisassemble: engineSupported,
      canAnalyzeDataflow: arm64Analysis,
      canEmulate: emulationSupported,
      viewerCanDisassemble: engineSupported && !!adapter.viewerCompatible,
      instructionAlignment: adapter.instructionAlignment,
      fixedInstructionSize: adapter.fixedInstructionSize,
      engineVerified: !!engine.verified,
      analysisLevel,
      partial: analysisLevel === "partial",
      limitations: architecture === "arm64e" ? Object.freeze(["pointer-authentication data semantics are conservative"]) : Object.freeze([])
    });
  }
  var ARM64_ADAPTER = registerArchitectureAdapter({
    id: "arm64",
    instructionAlignment: 4,
    fixedInstructionSize: 4,
    viewerCompatible: true,
    assemble,
    controlFlow(instruction) {
      const op = String(instruction?.mnemonic || "").toLowerCase();
      if (/^ret(?:aa|ab)?$/.test(op)) return "return";
      if (/^(?:bl|blr|blraa|blrab|blraaz|blrabz)$/.test(op)) return "call";
      if (/^(?:b|br|braa|brab|braaz|brabz)$/.test(op)) return "branch";
      if (op.startsWith("b.") || op === "cbz" || op === "cbnz" || op === "tbz" || op === "tbnz") return "conditional-branch";
      return "fallthrough";
    },
    callKind(instruction) {
      return /^(?:bl|blr|blraa|blrab|blraaz|blrabz)$/i.test(instruction?.mnemonic || "") ? "call" : null;
    },
    returnKind(instruction) {
      return /^ret(?:aa|ab)?$/i.test(instruction?.mnemonic || "") ? "return" : null;
    }
  });
  registerArchitectureAdapter({
    id: "arm64e",
    instructionAlignment: ARM64_ADAPTER.instructionAlignment,
    fixedInstructionSize: ARM64_ADAPTER.fixedInstructionSize,
    viewerCompatible: ARM64_ADAPTER.viewerCompatible,
    assemble: ARM64_ADAPTER.assemble,
    controlFlow: ARM64_ADAPTER.controlFlow,
    callKind: ARM64_ADAPTER.callKind,
    returnKind: ARM64_ADAPTER.returnKind
  });
  registerArchitectureAdapter({
    id: "x86_64",
    instructionAlignment: 1,
    fixedInstructionSize: null,
    viewerCompatible: false,
    controlFlow(instruction) {
      const op = String(instruction?.mnemonic || "").toLowerCase();
      if (op.startsWith("ret")) return "return";
      if (op === "call") return "call";
      if (op === "jmp") return "branch";
      if (/^j[^m]/.test(op)) return "conditional-branch";
      return "fallthrough";
    },
    callKind(instruction) {
      return /^call$/i.test(instruction?.mnemonic || "") ? "call" : null;
    },
    returnKind(instruction) {
      return /^ret/.test(String(instruction?.mnemonic || "").toLowerCase()) ? "return" : null;
    }
  });
  registerArchitectureAdapter({ id: "unknown", instructionAlignment: 1, fixedInstructionSize: null, viewerCompatible: false });

  // js/platform/capstone-capability.js
  var DEPLOYED_CAPSTONE_SUPPORT = Object.freeze({
    arm64: true,
    x86_64: true
  });

  // js/platform/describe.js
  function displayFormat(image2) {
    if (image2.format === "elf") return `ELF ${image2.bits || "?"}-bit`;
    if (image2.format === "pe") return image2.bits === 64 ? "PE32+" : "PE32";
    if (image2.format === "macho") return `Mach-O ${image2.bits || "?"}-bit`;
    return String(image2.format || "Raw binary");
  }
  function regionFrom(item, id, kind) {
    const fileSize = BigInt(item.fileSize ?? item.size ?? 0);
    const declaredSize = BigInt(item.size ?? fileSize);
    const section = kind === "section" ? item.name || "" : null;
    return {
      id,
      kind,
      name: item.name || (kind === "segment" ? `Segment ${id}` : `Section ${id}`),
      segment: item.segment || (kind === "segment" ? item.name || null : null),
      section,
      fileOffset: BigInt(item.fileOffset ?? 0),
      vmAddr: BigInt(item.address ?? 0),
      size: fileSize,
      declaredSize,
      exec: !!item.perms?.execute,
      write: !!item.perms?.write,
      read: !!item.perms?.read,
      zerofill: fileSize === 0n && declaredSize > 0n,
      truncated: false,
      cstrings: /cstring|string|strtab|rdata|rodata/i.test(item.name || "")
    };
  }
  function regionsForImage(image2, prefix = "p0_") {
    const sections = image2.sections || [];
    const usefulSections = sections.filter((s) => BigInt(s.fileSize ?? s.size ?? 0) > 0n || BigInt(s.size ?? 0) > 0n);
    const source2 = usefulSections.length ? usefulSections : image2.segments || [];
    const kind = usefulSections.length ? "section" : "segment";
    return source2.map((item, index) => regionFrom(item, `${prefix}${kind[0]}${index}`, kind));
  }
  function describeBinaryImage(image2, options = {}) {
    const requestedEngine = options.engine || {};
    const engine = {
      ...DEPLOYED_CAPSTONE_SUPPORT,
      ...requestedEngine,
      verified: requestedEngine.verified === true
    };
    const capability = architectureCapability(image2, engine);
    const regions2 = regionsForImage(image2);
    const info = {
      cpu: image2.arch || "unknown",
      cpuSub: image2.metadata?.subtypeName || (image2.metadata?.subtypeBase == null ? "all" : String(image2.metadata.subtypeBase)),
      is64: image2.bits === 64,
      isArm64: image2.arch === "arm64" || image2.arch === "arm64e",
      isArm64e: image2.arch === "arm64e",
      textVM: regions2.find((r) => r.exec)?.vmAddr ?? image2.imageBase ?? 0n,
      encrypted: false,
      endian: image2.endian,
      format: image2.format,
      capability
    };
    const summary = image2.summary();
    const formatMetadata = {
      format: image2.format,
      arch: image2.arch,
      bits: image2.bits,
      endian: image2.endian
    };
    if (image2.platform != null) formatMetadata.platform = image2.platform;
    if (image2.abi != null) formatMetadata.abi = image2.abi;
    if (image2.entrypoint != null) formatMetadata.entrypoint = image2.entrypoint;
    if (image2.imageBase != null) formatMetadata.imageBase = image2.imageBase;
    const productDescriptor = {
      formatId: image2.format || "raw",
      regions: regions2,
      dependencies: [...image2.libraries || []],
      imports: [...image2.imports || []],
      exports: [...image2.exports || []],
      formatMetadata
    };
    info.descriptor = productDescriptor;
    const raw = {
      id: "raw",
      kind: "file",
      name: "Whole file (raw)",
      fileOffset: 0n,
      vmAddr: 0n,
      size: image2.fileSize,
      declaredSize: image2.fileSize,
      exec: false,
      write: false,
      read: true,
      zerofill: false,
      truncated: false
    };
    return {
      name: options.name || "binary",
      size: image2.fileSize,
      format: displayFormat(image2),
      formatId: image2.format,
      slices: [{ name: image2.arch || "unknown", offset: image2.fileOffset || 0n, size: image2.fileSize, info, capability, regions: regions2 }],
      raw,
      productDescriptor,
      warnings: [...image2.warnings || []],
      capability,
      platform: {
        summary,
        sourceBacked: !!image2.metadata?.sourceBacked,
        sourceReads: image2.metadata?.sourceReads || null,
        metadataKeys: Object.keys(image2.metadata || {}).sort()
      }
    };
  }

  // js/vendors.js
  var VENDOR_PATTERNS = [
    { vendor: "IronSource", kind: "ads", re: /ironsource|supersonic|levelplay/i },
    { vendor: "AppLovin", kind: "ads", re: /applovin|\bmax(mediation|adview|reward)/i },
    { vendor: "Google Mobile Ads", kind: "ads", re: /admob|googlemobileads|gadmob|interstitialad/i },
    { vendor: "Unity Ads", kind: "ads", re: /unityads|unityservices|unityanalytics/i },
    { vendor: "Vungle", kind: "ads", re: /vungle|liftoff/i },
    { vendor: "Tapjoy", kind: "ads", re: /tapjoy/i },
    { vendor: "AdColony", kind: "ads", re: /adcolony/i },
    { vendor: "Chartboost", kind: "ads", re: /chartboost/i },
    { vendor: "Mintegral", kind: "ads", re: /mintegral|mtgsdk/i },
    { vendor: "Pangle", kind: "ads", re: /pangle|bytedance|pangrowth/i },
    { vendor: "InMobi", kind: "ads", re: /inmobi/i },
    { vendor: "Fyber", kind: "ads", re: /fyber|digitalturbine/i },
    { vendor: "Smaato", kind: "ads", re: /smaato/i },
    { vendor: "PubMatic", kind: "ads", re: /pubmatic|openwrap/i },
    { vendor: "Moloco", kind: "ads", re: /moloco/i },
    { vendor: "BidMachine", kind: "ads", re: /bidmachine/i },
    { vendor: "Ogury", kind: "ads", re: /ogury/i },
    { vendor: "Criteo", kind: "ads", re: /criteo/i },
    { vendor: "Meta Audience Network", kind: "ads", re: /audiencenetwork|fbaudience|fbnativead|fbadwebkit/i },
    { vendor: "Yandex Ads", kind: "ads", re: /yandexmobileads/i },
    { vendor: "Adjust", kind: "analytics", re: /\badjust(sdk)?\b|adjustattribution/i },
    { vendor: "AppsFlyer", kind: "analytics", re: /appsflyer/i },
    { vendor: "Branch", kind: "analytics", re: /branchsdk|branchuniversal/i },
    { vendor: "Singular", kind: "analytics", re: /singularsdk/i },
    { vendor: "Kochava", kind: "analytics", re: /kochava/i },
    { vendor: "Tenjin", kind: "analytics", re: /tenjin/i },
    { vendor: "Amplitude", kind: "analytics", re: /amplitude/i },
    { vendor: "Mixpanel", kind: "analytics", re: /mixpanel/i },
    { vendor: "GameAnalytics", kind: "analytics", re: /gameanalytics/i },
    { vendor: "Flurry", kind: "analytics", re: /flurry/i },
    { vendor: "Adobe", kind: "analytics", re: /adobemobile|adbmobile/i },
    { vendor: "Firebase", kind: "analytics", re: /firebase|\bfirapp\b|firanalytics|googleutilities|googledatatransport/i },
    { vendor: "Crashlytics", kind: "analytics", re: /crashlytics/i },
    { vendor: "Sentry", kind: "analytics", re: /sentrysdk|sentryclient/i },
    { vendor: "Bugsnag", kind: "analytics", re: /bugsnag/i },
    { vendor: "Braze", kind: "marketing", re: /\bappboy\b|brazekit/i },
    { vendor: "Leanplum", kind: "marketing", re: /leanplum/i },
    { vendor: "Swrve", kind: "marketing", re: /swrve/i },
    { vendor: "OneSignal", kind: "marketing", re: /onesignal/i },
    { vendor: "Helpshift", kind: "support", re: /helpshift/i },
    { vendor: "Zendesk", kind: "support", re: /zendesk/i },
    { vendor: "Google Toolbox", kind: "library", re: /gtmsession|gtmapp|googletoolbox/i },
    { vendor: "Protocol Buffers", kind: "library", re: /swiftprotobuf|google_protobuf/i },
    { vendor: "AFNetworking", kind: "library", re: /afnetworking|afhttp|afurl/i },
    { vendor: "Alamofire", kind: "library", re: /alamofire/i },
    { vendor: "Realm", kind: "library", re: /realmswift|rlmobject/i }
  ];
  function matchPattern(name) {
    const s = String(name || "");
    for (const p of VENDOR_PATTERNS) {
      if (p.re.test(s)) return { vendor: p.vendor, kind: p.kind, via: "name" };
    }
    return null;
  }
  function vendorInText(text) {
    const direct = matchPattern(text);
    return direct ? Object.assign({ confidence: "high" }, direct) : null;
  }

  // js/signature/index.js
  var LIBRARIES = [
    { name: "libSystem", classification: "SYSTEM", kind: "runtime", libraries: [/libSystem\./i], symbols: [/^_?(malloc|free|memcpy|pthread_)/] },
    { name: "Foundation", classification: "SYSTEM", kind: "runtime", libraries: [/Foundation\.framework/i], symbols: [/^_?NS[A-Z]/] },
    { name: "CoreFoundation", classification: "SYSTEM", kind: "runtime", libraries: [/CoreFoundation\.framework/i], symbols: [/^_?CF[A-Z]/] },
    { name: "Swift runtime", classification: "RUNTIME", kind: "runtime", libraries: [/libswift(Core|Foundation|Concurrency)/i], symbols: [/^_?swift_/] },
    { name: "libc++", classification: "LIBRARY", kind: "library", libraries: [/libc\+\+/i], symbols: [/__ZSt|std::/] },
    { name: "SQLite", classification: "LIBRARY", kind: "library", libraries: [/sqlite3/i], symbols: [/^_?sqlite3_/] },
    { name: "zlib", classification: "LIBRARY", kind: "library", libraries: [/libz\.|zlib/i], symbols: [/^_?(inflate|deflate|crc32)$/] },
    { name: "Compression", classification: "SYSTEM", kind: "library", libraries: [/Compression\.framework/i], symbols: [/^_?compression_/] },
    { name: "CommonCrypto", classification: "SYSTEM", kind: "crypto", libraries: [/libcommonCrypto|Security\.framework/i], symbols: [/^_?CC(Crypt|_SHA|_MD5|KeyDerivation)/] },
    { name: "OpenSSL/BoringSSL", classification: "LIBRARY", kind: "crypto", libraries: [/lib(ssl|crypto)|boringssl/i], symbols: [/^_?(SSL_|EVP_|CRYPTO_|OPENSSL_)/] },
    { name: "Protocol Buffers", classification: "LIBRARY", kind: "library", libraries: [/protobuf/i], symbols: [/google::protobuf|GPBMessage|swiftprotobuf/i] },
    { name: "Unity", classification: "SDK", kind: "engine", libraries: [/UnityFramework/i], symbols: [/UnityEngine|UnityPlayer/] },
    { name: "IL2CPP", classification: "RUNTIME", kind: "runtime", libraries: [/libil2cpp|GameAssembly/i], symbols: [/^_?il2cpp_|il2cpp_codegen/] },
    { name: "Firebase", classification: "SDK", kind: "sdk", libraries: [/Firebase/i], symbols: [/FIR(App|Analytics)|firebase/i] },
    { name: "Google Mobile Ads", classification: "SDK", kind: "sdk", libraries: [/GoogleMobileAds/i], symbols: [/^_?GAD[A-Z]|googlemobileads/i] },
    { name: "AppLovin MAX", classification: "SDK", kind: "sdk", libraries: [/AppLovin/i], symbols: [/MA(Ad|Rewarded)|ALSdk|AppLovin/i] },
    { name: "IronSource LevelPlay", classification: "SDK", kind: "sdk", libraries: [/IronSource|LevelPlay/i], symbols: [/IronSource|LevelPlay|LPMReward/i] },
    { name: "AFNetworking", classification: "LIBRARY", kind: "library", libraries: [/AFNetworking/i], symbols: [/^_?AF(URL|HTTP|Network|Security)/] },
    { name: "Alamofire", classification: "LIBRARY", kind: "library", libraries: [/Alamofire/i], symbols: [/Alamofire/] },
    { name: "gRPC", classification: "LIBRARY", kind: "network", libraries: [/grpc/i], symbols: [/^_?grpc_|GRPC[A-Z]/] },
    { name: "libcurl", classification: "LIBRARY", kind: "network", libraries: [/libcurl|curl\.framework/i], symbols: [/^_?curl_(easy|multi|share|global)/] },
    { name: "SDWebImage", classification: "LIBRARY", kind: "library", libraries: [/SDWebImage/i], symbols: [/^_?SDWebImage/] }
  ];
  function textOf(value) {
    return typeof value === "string" ? value : value?.name || value?.library || value?.text || "";
  }
  function regexTest(rx, text) {
    if (!(rx instanceof RegExp)) return false;
    rx.lastIndex = 0;
    const matched = rx.test(text);
    rx.lastIndex = 0;
    return matched;
  }
  function hits(values, regexes) {
    const out = [];
    for (const value of values || []) {
      const s = textOf(value);
      if (s && regexes?.some((rx) => regexTest(rx, s))) out.push(s);
    }
    return [...new Set(out)].slice(0, 12);
  }
  function recognizeLibraries(input = {}, signatures = LIBRARIES) {
    const libraries = input.libraries || [], symbols = [...input.symbols || [], ...input.imports || []], strings = input.strings || [];
    const results = [];
    for (const sig of signatures) {
      const libraryHits = hits(libraries, sig.libraries), symbolHits = hits(symbols, sig.symbols), stringHits = hits(strings, sig.strings || []);
      const kinds = Number(libraryHits.length > 0) + Number(symbolHits.length > 0) + Number(stringHits.length > 0);
      if (!kinds) continue;
      let confidence = libraryHits.length ? 0.82 : 0.52;
      if (symbolHits.length) confidence += 0.11;
      if (stringHits.length) confidence += 0.04;
      if (!libraryHits.length && kinds < 2 && symbolHits.length < 2) confidence = Math.min(confidence, 0.62);
      results.push({ name: sig.name, library: sig.name, classification: sig.classification, kind: sig.kind, confidence: Math.min(0.98, confidence), confirmed: false, evidence: [...libraryHits, ...symbolHits, ...stringHits] });
    }
    const existing = new Set(results.map((x) => x.name.toLowerCase()));
    const vendorHits = /* @__PURE__ */ new Map();
    for (const [source2, values] of [["library", libraries], ["symbol", symbols], ["string", strings]]) {
      for (const value of values) {
        const text = textOf(value);
        if (!text) continue;
        const vendor = vendorInText(text);
        if (!vendor) continue;
        let record = vendorHits.get(vendor.vendor);
        if (!record) vendorHits.set(vendor.vendor, record = { values: /* @__PURE__ */ new Set(), sources: /* @__PURE__ */ new Set(), kind: vendor.kind });
        record.values.add(text);
        record.sources.add(source2);
      }
    }
    for (const [name, hit] of vendorHits) {
      if (existing.has(name.toLowerCase())) continue;
      const evidence = [...hit.values].slice(0, 12), evidenceKinds = [...hit.sources];
      let confidence = hit.sources.has("library") ? 0.82 : hit.sources.has("symbol") ? evidence.length >= 2 ? 0.68 : 0.56 : evidence.length >= 2 ? 0.56 : 0.46;
      if (hit.sources.size >= 2) confidence += 0.08;
      results.push({ name, library: name, classification: hit.kind === "library" ? "LIBRARY" : "SDK", kind: hit.kind, confidence: Math.min(0.92, confidence), confirmed: false, evidence, evidenceKinds });
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }
  var BUILTIN_LIBRARY_SIGNATURES = Object.freeze(LIBRARIES.slice());

  // js/recognition/match-budget.js
  var DEFAULT_MATCH_BUDGET = Object.freeze({
    // Preprocessing is deliberately budgeted separately from candidate/solver
    // work: raw-function fingerprinting can dominate both CPU and memory.
    maxPreprocessFunctions: 7e5,
    maxPreprocessInputBytes: 256 * 1024 * 1024,
    maxPreprocessEstimatedBytes: 256 * 1024 * 1024,
    maxPreprocessWork: 4e6,
    maxIndexEntries: 2e6,
    maxCandidateEvaluations: 5e5,
    maxCandidateEdges: 1e5,
    maxComponentNodes: 2048,
    maxComponentEdges: 2e4,
    maxSolverRelaxations: 5e5,
    maxSolverAugmentations: 2048,
    maxWallMs: 2e3
  });

  // js/knowledge/index.js
  var CONFIRMATION_LEVELS = Object.freeze(["user-confirmed", "debugger-confirmed", "metadata-confirmed", "high-confidence-inferred", "weak-inferred"]);
  function fingerprintVendors(input = {}) {
    return recognizeLibraries(input).map((x) => ({ name: x.name, kind: x.kind, confidence: x.confidence, confirmed: false, reasons: x.evidence, classification: x.classification }));
  }

  // js/platform/hash.js
  var FNV_OFFSET = 0xcbf29ce484222325n;
  var FNV_PRIME = 0x100000001b3n;
  var MASK64 = 0xffffffffffffffffn;
  async function hashByteSource(input, options = {}) {
    const source2 = asByteSource(input);
    const chunkSize = Math.min(options.chunkSize ?? 1024 * 1024, source2.maxReadLength);
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError("chunkSize must be a positive safe integer");
    let hash = FNV_OFFSET;
    let offset = 0n;
    while (offset < source2.size) {
      if (options.signal?.aborted) throw new Error("hash cancelled");
      const remaining = source2.size - offset;
      const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
      const bytes = await source2.readExactly(offset, length, { signal: options.signal });
      for (let i = 0; i < bytes.length; i++) {
        hash ^= BigInt(bytes[i]);
        hash = hash * FNV_PRIME & MASK64;
      }
      offset += BigInt(bytes.length);
      options.onProgress?.({ done: offset, total: source2.size });
    }
    return `fnv1a64:${source2.size.toString(16)}:${hash.toString(16).padStart(16, "0")}`;
  }

  // js/platform/worker-validation.js
  var MAX_SAFE_BIGINT3 = BigInt(Number.MAX_SAFE_INTEGER);
  function checkedChunkIndex(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Chunk index must be a non-negative safe integer.");
    return n;
  }
  function regionSize(value, label = "region size") {
    let n;
    try {
      n = typeof value === "bigint" ? value : BigInt(value);
    } catch {
      throw new RangeError(`${label} is invalid.`);
    }
    if (n < 0n) throw new RangeError(`${label} must be non-negative.`);
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new RangeError(`${label} must not enter the worker as an unsafe Number.`);
    }
    return n;
  }
  function boundedOffset(value, max, label = "offset") {
    const limit = regionSize(max, "range limit");
    if (value == null) return limit;
    const n = regionSize(value, label);
    return n > limit ? limit : n;
  }
  function chunkLength(remaining, cap) {
    const n = regionSize(remaining, "remaining range");
    if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError("chunk cap must be a non-negative safe integer.");
    const bounded = n < BigInt(cap) ? n : BigInt(cap);
    return Number(bounded);
  }
  function exactExternalInteger(value) {
    const n = regionSize(value, "integer");
    return n <= MAX_SAFE_BIGINT3 ? Number(n) : n;
  }
  function utf8Len(buf, index) {
    const c = buf[index];
    if (c < 128) return c >= 32 && c < 127 || c === 9 || c === 10 ? 1 : 0;
    let need = 0;
    if (c >= 194 && c <= 223) need = 1;
    else if (c >= 224 && c <= 239) need = 2;
    else if (c >= 240 && c <= 244) need = 3;
    else return 0;
    if (index + need >= buf.length) return -1;
    const b1 = buf[index + 1];
    if ((b1 & 192) !== 128) return 0;
    if (c === 224 && b1 < 160) return 0;
    if (c === 237 && b1 > 159) return 0;
    if (c === 240 && b1 < 144) return 0;
    if (c === 244 && b1 > 143) return 0;
    for (let k = 2; k <= need; k++) if ((buf[index + k] & 192) !== 128) return 0;
    return need + 1;
  }
  function isExactFunctionSeed(seed) {
    if (!seed || Number(seed.confidence ?? 0) < 0.9) return false;
    if (seed.exactFunctionStart === true) return true;
    const sources = /* @__PURE__ */ new Set([seed.source, ...seed.sources || []]);
    return [...sources].some((s) => ["entrypoint", "export", "exception", "unwind", "function_starts", "tls-callback", "guard-cf"].includes(s));
  }

  // js/platform/analysis-result.js
  function provenance(source2, confidence = 1) {
    return { source: source2 || "binary-metadata", confidence, confirmed: true };
  }
  function statusReasons(value, prefix, out) {
    if (!value || typeof value !== "object") return;
    if (value.complete === false) out.push(`${prefix}:incomplete`);
    if (value.bindingSitesComplete === false) out.push(`${prefix}:binding-sites-incomplete`);
    if (value.partialReason) out.push(`${prefix}:${value.partialReason}`);
    for (const reason of value.reasons || value.bindingSiteReasons || []) out.push(`${prefix}:${reason}`);
  }
  function machoSymbolTruth(image2) {
    if (!image2 || image2.format !== "macho") return null;
    const metadata = image2.metadata || {};
    const reasons = [];
    statusReasons(metadata.machoMetadata, "metadata-budget", reasons);
    statusReasons(metadata.chainedFixups, "chained-fixups", reasons);
    statusReasons(metadata.exportTrie, "export-trie", reasons);
    if (metadata.dyldBindings && typeof metadata.dyldBindings === "object") {
      for (const [kind, status] of Object.entries(metadata.dyldBindings)) statusReasons(status, `dyld-${kind}`, reasons);
    }
    const unique = [...new Set(reasons)].slice(0, 64);
    return {
      source: "BinaryImage",
      normalized: true,
      complete: unique.length === 0,
      reasons: unique,
      components: {
        chainedFixups: metadata.chainedFixups || null,
        dyldBindings: metadata.dyldBindings || null,
        exportTrie: metadata.exportTrie || null,
        metadataBudget: metadata.machoMetadata || null
      }
    };
  }
  function analysisFromBinaryImage(image2) {
    if (!image2) return emptyAnalysis();
    const entries = /* @__PURE__ */ new Map();
    const add = (address, name, kind, exported, prov, priority) => {
      if (address == null || !name) return;
      const addr = BigInt(address), key = addr.toString();
      const next = { address: addr, name: String(name), kind, exported: !!exported, provenance: prov, priority };
      const current2 = entries.get(key);
      if (!current2) {
        entries.set(key, next);
        return;
      }
      current2.exported ||= next.exported;
      if (next.priority > current2.priority) {
        current2.name = next.name;
        current2.kind = next.kind;
        current2.provenance = next.provenance;
        current2.priority = next.priority;
      }
    };
    for (const symbol of image2.symbols || []) {
      if (symbol?.defined === false || symbol?.address == null || !symbol.name) continue;
      add(symbol.address, symbol.name, 0, !!symbol.exported, provenance(symbol.source || "symbol-table", 0.99), 10);
    }
    for (const exp of image2.exports || []) {
      if (exp?.address == null || !exp.name) continue;
      add(exp.address, exp.name, 0, true, provenance(exp.source || "exports-trie", 1), 20);
    }
    for (const imp of image2.imports || []) {
      if (!imp?.name) continue;
      for (const site of imp.sites || []) {
        if (site?.address == null) continue;
        add(site.address, imp.name, 2, false, provenance(site.kind || imp.source || "dyld-bind", 1), 30);
      }
    }
    const sorted = [...entries.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
    const addrs = new BigUint64Array(sorted.length), kinds = new Uint8Array(sorted.length), flags = new Uint8Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) {
      addrs[i] = sorted[i].address;
      kinds[i] = sorted[i].kind;
      flags[i] = sorted[i].exported ? 1 : 0;
    }
    const seedByAddress = /* @__PURE__ */ new Map();
    for (const seed of image2.functions || []) if (seed?.address != null) seedByAddress.set(BigInt(seed.address).toString(), seed);
    const functions = [...seedByAddress.keys()].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const funcs = new BigUint64Array(functions);
    const functionProvenance = functions.map((addr) => {
      const seed = seedByAddress.get(addr.toString()) || {};
      const confirmed = isExactFunctionSeed(seed);
      return { source: seed.source || "heuristic", confidence: Number(seed.confidence ?? (confirmed ? 1 : 0.5)), confirmed };
    });
    const nameProvenance = sorted.map((entry) => entry.provenance);
    const allSeedsExact = functions.length > 0 && (image2.functions || []).every(isExactFunctionSeed);
    const discoveryComplete = image2.metadata?.functionDiscovery?.complete === true;
    return {
      addrs,
      kinds,
      flags,
      names: sorted.map((x) => x.name),
      funcs,
      functionProvenance,
      nameProvenance,
      symbolCount: addrs.length,
      funcCount: funcs.length,
      capped: false,
      allSeedsExact,
      discoveryComplete,
      functionStartsExact: discoveryComplete && allSeedsExact,
      functionDiscovery: { complete: discoveryComplete, capped: false, reasons: discoveryComplete ? [] : ["platform-function-seeds-not-exhaustive"] },
      symbolTruth: machoSymbolTruth(image2),
      __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer]
    };
  }
  function emptyAnalysis() {
    const addrs = new BigUint64Array(0), kinds = new Uint8Array(0), flags = new Uint8Array(0), funcs = new BigUint64Array(0);
    return {
      addrs,
      kinds,
      flags,
      names: [],
      funcs,
      symbolCount: 0,
      funcCount: 0,
      capped: false,
      allSeedsExact: false,
      discoveryComplete: false,
      functionStartsExact: false,
      functionDiscovery: { complete: false, capped: false, reasons: ["platform-function-seeds-not-exhaustive"] },
      symbolTruth: null,
      __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer]
    };
  }

  // js/platform/worker.js
  var ROW_BYTES = 4;
  var CHUNK_ROWS = 1024;
  var CHUNK_BYTES = CHUNK_ROWS * ROW_BYTES;
  var SCAN_BLOCK = 256 * 1024;
  var SEARCH_LIMIT = 1e3;
  var STRINGS_LIMIT = 5e5;
  var MAX_STRING_CHARS = 400;
  var decoder = new TextDecoder("utf-8", { fatal: false });
  var file = null;
  var source = null;
  var image = null;
  var descriptor = null;
  var regions = /* @__PURE__ */ new Map();
  var currentEpoch = 0;
  var openChain = Promise.resolve();
  var active = /* @__PURE__ */ new Map();
  self.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || typeof msg.t !== "string") return;
    if (msg.t === "cancel") {
      for (const entry of active.values()) {
        if ((msg.requestId == null || msg.requestId === entry.id) && (msg.epoch == null || msg.epoch === entry.epoch)) entry.controller.abort();
      }
      return;
    }
    const serialized = msg.t === "open" || msg.t === "detect";
    if (serialized) {
      currentEpoch = msg.epoch;
      for (const entry of active.values()) if (entry.epoch !== currentEpoch) entry.controller.abort();
    }
    const execute = async () => {
      if (msg.epoch !== currentEpoch) throw new Error("Stale platform request.");
      const controller = new AbortController();
      const requestKey = msg.id == null ? null : `${msg.epoch}:${msg.id}`;
      if (requestKey != null && active.has(requestKey)) throw new Error(`Duplicate active request id ${msg.id} for epoch ${msg.epoch}.`);
      if (requestKey != null) active.set(requestKey, { id: msg.id, epoch: msg.epoch, controller });
      try {
        return await handle(msg, controller.signal);
      } finally {
        if (requestKey != null && active.get(requestKey)?.controller === controller) active.delete(requestKey);
      }
    };
    try {
      const result = serialized ? openChain = openChain.then(execute, execute) : openChain.then(execute);
      const resolved = await result;
      post({ t: "ok", id: msg.id, epoch: msg.epoch, result: resolved }, resolved?.__transfer);
    } catch (error) {
      post({ t: "err", id: msg.id, epoch: msg.epoch, error: error?.message || String(error) });
    }
  };
  function post(message, transfer) {
    if (message.result) delete message.result.__transfer;
    if (transfer?.length) self.postMessage(message, transfer);
    else self.postMessage(message);
  }
  function progress(msg, phase, done, total, extra = {}) {
    self.postMessage({ t: "analysisProgress", requestId: msg.id, epoch: msg.epoch, phase, done, total, ...extra });
  }
  async function handle(msg, signal) {
    switch (msg.t) {
      case "detect":
        return detectFile(msg, signal);
      case "open":
        return openFile(msg, signal);
      case "setRegions":
        return setRegions(msg.regions);
      case "chunk":
        return getChunk(msg, signal);
      case "analyze":
        return analyzeImage(msg, signal);
      case "strings":
        return scanStrings2(msg, signal);
      case "search":
        return runSearch(msg, signal);
      case "readAt":
        return readAtAddress(msg, signal);
      case "guessFunctions":
        return genericFunctionSeeds();
      case "xrefs":
        return { results: [], cancelled: false, capped: false, unsupported: true };
      case "scanProgram":
        return emptyProgramScan(msg.regionId);
      case "fieldAccess":
        return msg.offsets ? { groups: Object.fromEntries((msg.offsets || []).map((x) => [String(x), []])), unsupported: true } : { results: [], unsupported: true };
      case "valueShapes":
        return { groups: [], unsupported: true };
      case "metadata":
        return metadataPage(msg);
      case "hash":
        return { hash: await hashByteSource(source, { signal, onProgress: ({ done, total }) => self.postMessage({ t: "analysisProgress", requestId: msg.id, epoch: msg.epoch, phase: "hash", done, total }) }) };
      case "memoryStats":
        return memoryStats();
      case "cleanupMemory":
        source?.clear?.();
        return memoryStats();
      case "probe":
        return { ok: true, capability: descriptor?.capability || null };
      default:
        throw new Error(`Unknown platform request: ${msg.t}`);
    }
  }
  function createSource(input) {
    const base = asByteSource(input, { maxReadLength: 8 * 1024 * 1024 });
    return new CachedByteSource(base, { pageSize: 256 * 1024, maxCachedBytes: 8 * 1024 * 1024 });
  }
  async function detectFile(msg, signal) {
    const candidate = msg.file;
    if (!candidate || !Number.isSafeInteger(candidate.size) || candidate.size <= 0) throw new Error("This file is empty or has an invalid size.");
    const temporary = createSource(candidate);
    try {
      const length = Math.min(16, candidate.size);
      const prefix = await temporary.readExactly(0n, length, { signal });
      if (signal.aborted) throw new Error("Open cancelled");
      const detected = detectBinary(prefix);
      return { formatId: detected.format, fat: !!detected.fat, size: BigInt(candidate.size), sourceBacked: true };
    } finally {
      temporary.clear?.();
    }
  }
  async function openFile(msg, signal) {
    const candidateFile = msg.file;
    if (!candidateFile || !Number.isSafeInteger(candidateFile.size) || candidateFile.size <= 0) throw new Error("This file is empty or has an invalid size.");
    progress(msg, "header", 0, 7);
    const candidateSource = createSource(candidateFile);
    const cancellable = {
      size: candidateSource.size,
      maxReadLength: candidateSource.maxReadLength,
      read: (offset, length, options = {}) => candidateSource.read(offset, length, { ...options, signal })
    };
    let candidateImage, candidateDescriptor;
    try {
      candidateImage = await openBinarySource(cancellable, {
        ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 }
      });
      if (signal.aborted) throw new Error("Open cancelled");
      progress(msg, "sections", 2, 7);
      const engine = {
        arm64: candidateImage.arch === "arm64" || candidateImage.arch === "arm64e",
        arm64e: candidateImage.arch === "arm64e",
        verified: false
      };
      candidateDescriptor = describeBinaryImage(candidateImage, { name: candidateFile.name || "binary", engine });
      candidateDescriptor.platform.vendorCandidates = fingerprintVendors({ libraries: candidateImage.libraries, imports: candidateImage.imports, symbols: candidateImage.symbols });
      const candidateRegions = /* @__PURE__ */ new Map();
      for (const region of candidateDescriptor.slices.flatMap((s) => s.regions)) if (region?.id) candidateRegions.set(region.id, region);
      candidateRegions.set(candidateDescriptor.raw.id, candidateDescriptor.raw);
      progress(msg, "symbols", 3, 7, { count: candidateImage.symbols.length });
      progress(msg, "imports", 4, 7, { count: candidateImage.imports.length });
      progress(msg, "strings", 4, 7, { deferred: true });
      progress(msg, "functions", 5, 7, { count: candidateImage.functions.length });
      progress(msg, "expensive", 5, 7, { deferred: true });
      const previousSource = source;
      file = candidateFile;
      source = candidateSource;
      image = candidateImage;
      descriptor = candidateDescriptor;
      regions = candidateRegions;
      if (previousSource && previousSource !== candidateSource) previousSource.clear?.();
      return candidateDescriptor;
    } catch (error) {
      candidateSource.clear?.();
      throw error;
    }
  }
  function setRegions(list) {
    for (const region of list || []) if (region?.id) regions.set(region.id, region);
    return { ok: true };
  }
  async function readFileRange(offset, length, signal) {
    if (!source) throw new Error("No binary is open.");
    return source.readExactly(offset, length, { signal });
  }
  async function getChunk({ regionId, chunk }, signal) {
    const region = regions.get(regionId);
    if (!region) throw new Error("Unknown region.");
    const chunkIndex = checkedChunkIndex(chunk);
    const rel = BigInt(chunkIndex) * BigInt(CHUNK_BYTES);
    const remaining = regionSize(region.size) - rel;
    if (remaining <= 0n) return { regionId, chunk, bytes: new Uint8Array(0), mn: "", ops: "", rows: 0 };
    const length = chunkLength(remaining, CHUNK_BYTES);
    const bytes = await readFileRange(BigInt(region.fileOffset) + rel, length, signal);
    const copy = bytes.slice();
    return { regionId, chunk, bytes: copy, mn: "", ops: "", rows: Math.ceil(copy.length / ROW_BYTES), __transfer: [copy.buffer] };
  }
  async function analyzeImage(msg, signal) {
    if (!image) return emptyAnalysis();
    let selected = image;
    if (image.metadata?.fat?.slices?.length && msg.sliceIndex != null) {
      selected = await parseMachOSource(source, {
        sliceIndex: msg.sliceIndex,
        signal,
        ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024, maxReads: 4096 }
      });
    }
    if (signal.aborted) throw new Error("Analysis cancelled");
    return analysisFromBinaryImage(selected);
  }
  function genericFunctionSeeds() {
    const values = [...new Set((image?.functions || []).map((f) => BigInt(f.address).toString()))].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const starts = new BigUint64Array(values);
    const allSeedsExact = values.length > 0 && (image?.functions || []).every(isExactFunctionSeed);
    return {
      starts,
      cancelled: false,
      exact: allSeedsExact,
      allSeedsExact,
      complete: false,
      discoveryComplete: false,
      completeness: { complete: false, capped: false, reasons: ["platform-function-discovery-not-exhaustive"] },
      __transfer: [starts.buffer]
    };
  }
  function emptyProgramScan(regionId = null) {
    const callFrom = new BigUint64Array(0), callTo = new BigUint64Array(0), refFrom = new BigUint64Array(0), refTo = new BigUint64Array(0);
    const refKind = new Uint8Array(0), kinds = new Uint8Array(0);
    return {
      regionId,
      callFrom,
      callTo,
      refFrom,
      refTo,
      refKind,
      kinds,
      kindsCovered: 0,
      callsCapped: false,
      refsCapped: false,
      words: 0,
      unsupported: true,
      architecture: image?.arch || null,
      completeness: { complete: false, reasons: ["unsupported-program-analysis"] },
      __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer]
    };
  }
  async function scanStrings2(msg, signal) {
    const region = regions.get(msg.regionId);
    if (!region) throw new Error("Unknown region.");
    const minLength = Math.max(2, Number(msg.min) || 4);
    const cap = Math.min(Math.max(1, Number(msg.limit) || STRINGS_LIMIT), STRINGS_LIMIT);
    const regionBytes = regionSize(region.size);
    const total = msg.maxBytes == null ? regionBytes : boundedOffset(msg.maxBytes, regionBytes, "maxBytes");
    const out = [];
    let pos = 0n, runStart = null, runBytes = [];
    const flush = () => {
      if (runStart != null && runBytes.length) {
        const text = decoder.decode(new Uint8Array(runBytes)).replace(/\t/g, "\\t").replace(/\n/g, "\\n");
        if (text.length >= minLength) out.push({ addr: BigInt(region.vmAddr) + runStart, offset: exactExternalInteger(runStart), text });
      }
      runStart = null;
      runBytes = [];
    };
    let carry = new Uint8Array(0), carryAt = 0n;
    while (pos < total && out.length < cap) {
      if (signal.aborted) return { results: out, cancelled: true, capped: false, scannedBytes: exactExternalInteger(pos), complete: false };
      const want = chunkLength(total - pos, SCAN_BLOCK);
      const block = await readFileRange(BigInt(region.fileOffset) + pos, want, signal);
      if (!block.length) break;
      let buffer = block, base = pos;
      if (carry.length) {
        buffer = new Uint8Array(carry.length + block.length);
        buffer.set(carry);
        buffer.set(block, carry.length);
        base = carryAt;
      }
      const last = pos + BigInt(block.length) >= total;
      let i = 0;
      for (; i < buffer.length; i++) {
        const n = utf8Len(buffer, i);
        if (n === -1 && !last) break;
        if (n <= 0) {
          flush();
          if (out.length >= cap) break;
          continue;
        }
        if (runStart == null) {
          runStart = base + BigInt(i);
          runBytes = [];
        }
        if (runBytes.length < MAX_STRING_CHARS * 4) for (let k = 0; k < n; k++) runBytes.push(buffer[i + k]);
        i += n - 1;
      }
      carry = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
      carryAt = base + BigInt(i);
      pos += BigInt(block.length);
      self.postMessage({ t: "scanProgress", requestId: msg.id, epoch: msg.epoch, done: exactExternalInteger(pos), all: exactExternalInteger(total), hits: out.length });
      await Promise.resolve();
    }
    flush();
    return {
      results: out.slice(0, cap),
      cancelled: false,
      capped: out.length >= cap,
      truncationReason: out.length >= cap ? "result-limit" : total < regionBytes ? "input-budget" : null,
      scannedBytes: exactExternalInteger(pos),
      complete: pos >= regionBytes && out.length < cap
    };
  }
  async function runSearch(msg, signal) {
    const region = regions.get(msg.regionId);
    if (!region) throw new Error("Unknown region.");
    if (msg.kind !== "hex" && msg.kind !== "text") return { cancelled: false, results: [], scanned: 0, capped: false, unsupported: true };
    const total = regionSize(region.size);
    const start = boundedOffset(msg.from ?? 0, total, "search start");
    let pattern, mask = null;
    if (msg.kind === "hex") {
      pattern = msg.hex?.bytes;
      mask = msg.hex?.mask;
      if (!pattern?.length) throw new Error("Enter a hex pattern.");
    } else {
      const q = String(msg.query || "");
      if (!q) throw new Error("Enter text to search for.");
      pattern = new TextEncoder().encode(q.toLowerCase());
    }
    const results = [];
    let pos = start, carry = new Uint8Array(0), capped = false;
    while (pos < total && !capped) {
      if (signal.aborted) return { cancelled: true, results, scanned: exactExternalInteger(pos - start), capped: false };
      const block = await readFileRange(BigInt(region.fileOffset) + pos, chunkLength(total - pos, SCAN_BLOCK), signal);
      const joined = carry.length ? concat2(carry, block) : block;
      const base = pos - BigInt(carry.length);
      for (let i = 0; i <= joined.length - pattern.length; i++) {
        let ok = true;
        for (let j = 0; j < pattern.length; j++) {
          const actual = msg.kind === "text" ? lower(joined[i + j]) : joined[i + j];
          const expected = pattern[j];
          if (msg.kind === "hex" ? (actual & mask[j]) !== expected : actual !== expected) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const byteOff = base + BigInt(i);
        results.push({ row: exactExternalInteger(byteOff / BigInt(ROW_BYTES)), addr: BigInt(region.vmAddr) + byteOff, byteOff: exactExternalInteger(byteOff) });
        if (results.length >= SEARCH_LIMIT) {
          capped = true;
          break;
        }
      }
      pos += BigInt(block.length);
      carry = pattern.length > 1 ? joined.slice(Math.max(0, joined.length - pattern.length + 1)) : new Uint8Array(0);
      self.postMessage({
        t: "searchProgress",
        requestId: msg.id,
        epoch: msg.epoch,
        done: exactExternalInteger(pos - start),
        all: exactExternalInteger(total - start),
        hits: results.length
      });
    }
    return { cancelled: false, results, scanned: exactExternalInteger(pos - start), capped };
  }
  function lower(byte) {
    return byte >= 65 && byte <= 90 ? byte + 32 : byte;
  }
  function concat2(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }
  function vmToFile(address) {
    const at = BigInt(address);
    for (const region of regions.values()) {
      if (region.id === "raw" || region.zerofill) continue;
      const start = BigInt(region.vmAddr), size = BigInt(region.size);
      if (at >= start && at < start + size) return { region, offset: BigInt(region.fileOffset) + (at - start) };
    }
    const offset = image?.addressToOffset(at);
    return offset == null ? null : { region: null, offset };
  }
  async function readAtAddress(msg, signal) {
    const hit = vmToFile(msg.addr);
    if (!hit) return { found: false };
    const requested = Math.min(Math.max(0, Number(msg.len) || 256), 1 << 20);
    let available = image.fileSize - hit.offset;
    if (hit.region) available = BigInt(hit.region.fileOffset) + BigInt(hit.region.size) - hit.offset;
    const length = Number(available < BigInt(requested) ? available : BigInt(requested));
    const bytes = (await readFileRange(hit.offset, length, signal)).slice();
    const result = { found: true, region: hit.region?.name || null, fileOffset: hit.offset, bytes };
    if (msg.text) {
      const end = bytes.indexOf(0);
      result.text = decoder.decode(end >= 0 ? bytes.subarray(0, end) : bytes);
      result.terminated = end >= 0;
    }
    result.__transfer = [bytes.buffer];
    return result;
  }
  function metadataPage(msg) {
    if (!image) throw new Error("No parsed universal binary is open.");
    const collections = {
      segments: image.segments,
      sections: image.sections,
      imports: image.imports,
      exports: image.exports,
      symbols: image.symbols,
      relocations: image.relocations,
      functions: image.functions,
      libraries: image.libraries
    };
    if (msg.kind === "summary") return { summary: image.summary(), metadata: image.metadata, capability: descriptor?.capability || null };
    const list = collections[msg.kind];
    if (!list) throw new Error(`Unknown metadata kind: ${msg.kind}`);
    const start = Math.max(0, Number(msg.start) || 0);
    const limit = Math.min(5e3, Math.max(1, Number(msg.limit) || 500));
    return { kind: msg.kind, start, total: list.length, items: list.slice(start, start + limit), next: start + limit < list.length ? start + limit : null };
  }
  function memoryStats() {
    const sourceStats = source?.memoryStats?.() || {};
    return {
      ...sourceStats,
      functionsIndexed: image?.functions?.length || 0,
      stringsIndexed: 0,
      estimatedMemory: (sourceStats.bytesCached || 0) + (image?.functions?.length || 0) * 64 + (image?.symbols?.length || 0) * 96
    };
  }
})();
