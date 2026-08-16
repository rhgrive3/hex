import fs from 'node:fs';
import path from 'node:path';

export function stableValue(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('semantic-verification-cyclic-value');
  seen.add(value);
  try {
    if (value instanceof Map) {
      return {
        $map: [...value.entries()]
          .map(([key, item]) => [stableValue(key, seen), stableValue(item, seen)])
          .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))),
      };
    }
    if (value instanceof Set) {
      return {
        $set: [...value].map((item) => stableValue(item, seen)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      };
    }
    if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key], seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function canonicalClone(value) {
  return JSON.parse(stableStringify(value));
}

export function sortedUnique(values) {
  return [...new Set(values.map(String))].sort((a, b) => a.localeCompare(b));
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

export function walkFiles(root, relativeDirs, accept = (file) => /\.(?:m?js)$/.test(file)) {
  const files = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && accept(full)) files.push(full);
    }
  };
  for (const relative of relativeDirs) visit(path.join(root, relative));
  return files.sort((a, b) => a.localeCompare(b));
}

export function relativePosix(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export function makeResult(name, passed, details = {}) {
  return Object.freeze({ name, passed: Boolean(passed), ...details });
}
