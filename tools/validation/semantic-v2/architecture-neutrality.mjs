import fs from 'node:fs';
import { lineOf, relativePosix, walkFiles } from './core.mjs';

const DEFAULT_DIRS = Object.freeze(['js/semantics/ssa', 'js/semantics/memoryssa']);
const FORBIDDEN_IMPORT_PATTERNS = Object.freeze([
  { id: 'target-architecture-import', re: /(?:^|\/)targets\/architecture(?:\/|$)/ },
  { id: 'target-abi-import', re: /(?:^|\/)targets\/abi(?:\/|$)/ },
  { id: 'legacy-arm64-core-import', re: /(?:^|\/)(?:architecture\/compat\/ir-core-arm64-aapcs64-v1|ir-core)(?:\.js)?$/ },
  { id: 'legacy-architecture-import', re: /(?:^|\/)architecture(?:\/|$)/ },
]);

const ARCH_ATOMS = new Set(['arm64', 'arm64e', 'aarch64', 'x86', 'x86_64', 'amd64', 'riscv', 'riscv64', 'mips', 'ppc', 'powerpc']);
const ABI_ATOMS = new Set(['aapcs64', 'sysv-amd64', 'win64', 'riscv-psabi']);
const FLAG_ATOMS = new Set(['nzcv', 'eflags', 'rflags']);
const REGISTER_ATOMS = new Set([
  'x0','x1','x2','x3','x4','x5','x6','x7','x8','x9','x10','x11','x12','x13','x14','x15','x16','x17','x18','x19','x20','x21','x22','x23','x24','x25','x26','x27','x28','x29','x30',
  'w0','w1','w2','w3','w4','w5','w6','w7','sp','lr','fp',
  'rax','rbx','rcx','rdx','rsi','rdi','rsp','rbp','rip','eax','ebx','ecx','edx','esi','edi','esp','ebp','eip',
]);
const SELECTOR_IDENTIFIERS = new Set(['arch', 'architecture', 'architectureid', 'target', 'targetid', 'abi', 'abiid', 'register', 'registerid', 'flag', 'flagid']);

function normalizeAtom(value) {
  return String(value ?? '').trim().toLowerCase().replaceAll('-', '_');
}

function isArchAtom(value) {
  const atom = normalizeAtom(value);
  return ARCH_ATOMS.has(atom) || ABI_ATOMS.has(String(value ?? '').trim().toLowerCase()) || FLAG_ATOMS.has(atom) || REGISTER_ATOMS.has(atom);
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const push = (kind, value, start) => tokens.push({ kind, value, start });
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i++;
      let value = '';
      while (i < source.length) {
        const current = source[i++];
        if (current === '\\') {
          if (i < source.length) value += source[i++];
          continue;
        }
        if (current === quote) break;
        value += current;
      }
      push('string', value, start);
      continue;
    }
    if (ch === '`') {
      const start = i++;
      let value = '';
      let interpolation = false;
      while (i < source.length) {
        const current = source[i++];
        if (current === '\\') { if (i < source.length) value += source[i++]; continue; }
        if (current === '`') break;
        if (current === '$' && source[i] === '{') interpolation = true;
        value += current;
      }
      push(interpolation ? 'template' : 'string', value, start);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_$-]/.test(source[i])) i += 1;
      push('identifier', source.slice(start, i), start);
      continue;
    }
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (['===','!==','>>>','**=','&&=','||=','??='].includes(three)) { push('punct', three, i); i += 3; continue; }
    if (['==','!=','=>','<=','>=','&&','||','??','?.','++','--','<<','>>','**'].includes(two)) { push('punct', two, i); i += 2; continue; }
    push('punct', ch, i);
    i += 1;
  }
  return tokens;
}

function maskComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      out += '  '; i += 2;
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += '  '; i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '; i += 1;
      }
      if (i < source.length) { out += '  '; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; out += ch; i += 1;
      while (i < source.length) {
        const current = source[i]; out += current; i += 1;
        if (current === '\\' && i < source.length) { out += source[i]; i += 1; continue; }
        if (current === quote) break;
      }
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

function importSpecifiers(source) {
  const out = [];
  const masked = maskComments(source);
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(masked))) out.push({ specifier: match[1], start: match.index });
  }
  return out;
}

function conditionRanges(tokens) {
  const ranges = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].kind !== 'identifier' || !['if','switch','while'].includes(tokens[i].value)) continue;
    let open = i + 1;
    while (open < tokens.length && tokens[open].value !== '(') open += 1;
    if (open >= tokens.length) continue;
    let depth = 0;
    for (let j = open; j < tokens.length; j += 1) {
      if (tokens[j].value === '(') depth += 1;
      else if (tokens[j].value === ')') {
        depth -= 1;
        if (depth === 0) { ranges.push([open + 1, j]); i = open; break; }
      }
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].value !== '?') continue;
    ranges.push([Math.max(0, i - 16), i]);
  }
  return ranges;
}

function tokenLooksSelector(token) {
  if (!token) return false;
  if (token.kind === 'identifier') {
    const atom = normalizeAtom(token.value).replaceAll('_', '');
    return SELECTOR_IDENTIFIERS.has(atom) || isArchAtom(token.value);
  }
  return token.kind === 'string' && isArchAtom(token.value);
}

function architectureLogicViolations(source) {
  const tokens = tokenize(source);
  const violations = [];
  const seen = new Set();
  const add = (kind, token, reason) => {
    const key = `${kind}:${token.start}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ kind, start: token.start, reason, token: token.value });
  };

  for (const token of tokens) {
    if (token.kind === 'identifier' && (FLAG_ATOMS.has(normalizeAtom(token.value)) || REGISTER_ATOMS.has(normalizeAtom(token.value)))) {
      add('target-specific-state', token, 'generic SSA/MemorySSA must not interpret a concrete target register or flag');
    }
  }

  for (const [start, end] of conditionRanges(tokens)) {
    for (let i = start; i < end; i += 1) {
      const token = tokens[i];
      if ((token.kind === 'string' && isArchAtom(token.value)) || (token.kind === 'identifier' && isArchAtom(token.value))) {
        add('target-specific-branch', token, 'generic SSA/MemorySSA must not branch on architecture/ABI/register data');
      }
    }
  }
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i].kind === 'identifier' && tokens[i].value === 'case' && isArchAtom(tokens[i + 1].value)) {
      add('target-specific-branch', tokens[i + 1], 'generic SSA/MemorySSA must not switch on architecture/ABI/register data');
    }
  }

  const comparisonOps = new Set(['===','!==','==','!=']);
  for (let i = 1; i + 1 < tokens.length; i += 1) {
    if (!comparisonOps.has(tokens[i].value)) continue;
    const left = tokens[i - 1];
    const right = tokens[i + 1];
    if ((tokenLooksSelector(left) && isArchAtom(right.value)) || (tokenLooksSelector(right) && isArchAtom(left.value))) {
      const token = isArchAtom(left.value) ? left : right;
      add('target-specific-comparison', token, 'generic SSA/MemorySSA must not select behavior by target identity');
    }
  }
  return violations;
}

export function analyzeArchitectureNeutralSource(source, file = '<memory>') {
  const violations = [];
  for (const imported of importSpecifiers(source)) {
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (!pattern.re.test(imported.specifier)) continue;
      violations.push({ file, line: lineOf(source, imported.start), kind: pattern.id, token: imported.specifier, reason: 'generic SSA/MemorySSA may not import concrete target or legacy semantic implementations' });
    }
  }
  for (const item of architectureLogicViolations(source)) {
    violations.push({ file, line: lineOf(source, item.start), kind: item.kind, token: item.token, reason: item.reason });
  }
  return violations.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || String(a.token).localeCompare(String(b.token)));
}

export function scanArchitectureNeutrality({ root, directories = DEFAULT_DIRS } = {}) {
  if (!root) throw new TypeError('architecture-neutrality-root-required');
  const files = walkFiles(root, directories, (file) => /\.(?:m?js)$/.test(file));
  const violations = [];
  for (const file of files) {
    const relative = relativePosix(root, file);
    const source = fs.readFileSync(file, 'utf8');
    violations.push(...analyzeArchitectureNeutralSource(source, relative));
  }
  return Object.freeze({ filesChecked: files.length, architectureLeakCount: violations.length, violations: Object.freeze(violations) });
}
