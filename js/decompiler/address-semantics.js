function safeExtendName(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

function wrapped(text) {
  const s = String(text || 'index');
  return /^[-+]?\w+(?:->\w+|\.\w+)*$/.test(s) ? s : `(${s})`;
}

export function renderExtendedIndex(indexText, extend = null) {
  const index = wrapped(indexText);
  switch (String(extend || '').toLowerCase()) {
    case 'sxtw': return `(int64_t)(int32_t)${index}`;
    case 'uxtw': return `(uint64_t)(uint32_t)${index}`;
    case 'sxtx': return `(int64_t)${index}`;
    case 'uxtx': return `(uint64_t)${index}`;
    case 'lsl': case '': return indexText;
    default: return `__arm64_index_${safeExtendName(extend)}(${index})`;
  }
}

export function renderIndexedMemory(baseText, indexText, { extend = null, scale = 0, size = 0 } = {}) {
  const shift = Math.max(0, Number(scale || 0));
  const bytes = Number(size || 0);
  const index = renderExtendedIndex(indexText, extend);
  const scaleBytes = 2 ** shift;
  if (bytes > 0 && Number.isSafeInteger(scaleBytes) && scaleBytes === bytes) {
    return `${wrapped(baseText)}[${index}]`;
  }
  const offset = shift ? `(${index} << ${shift})` : index;
  return `memory[${baseText} + ${offset}]`;
}

export function effectiveIndexOffset(value, extend = null, scale = 0) {
  let index = BigInt(value);
  switch (String(extend || '').toLowerCase()) {
    case 'sxtw': index = BigInt.asIntN(32, index); break;
    case 'uxtw': index = BigInt.asUintN(32, index); break;
    case 'sxtx': index = BigInt.asIntN(64, index); break;
    case 'uxtx': case 'lsl': case '': index = BigInt.asUintN(64, index); break;
    default: return null;
  }
  return index << BigInt(Math.max(0, Number(scale || 0)));
}
