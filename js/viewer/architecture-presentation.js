import { brief, categoryOf, explain } from '../arm64.js';

function normalizeArchitecture(value) { return String(value || '').trim().toLowerCase(); }

export function instructionCategory(architecture, mnemonic) {
  const arch = normalizeArchitecture(architecture);
  if (arch === 'arm64' || arch === 'arm64e') return categoryOf(mnemonic);
  return '';
}

export function instructionNote(architecture, { mnemonic, operands, address, style, context, previous = null } = {}) {
  const arch = normalizeArchitecture(architecture);
  if (arch !== 'arm64' && arch !== 'arm64e') return '';
  const base = String(mnemonic || '').toLowerCase();
  if ((base === 'add' || base === 'ldr') && previous && /^adrp$/i.test(previous.mnemonic || '')) {
    const e = explain(mnemonic, operands, address, { ...(context || {}), prev:{ mn:previous.mnemonic, ops:previous.operands || '' } });
    let text = style === 'pseudo' ? e.pseudo
      : style === 'both' ? e.pseudo + '   — ' + e.title
      : (e.summary || e.title);
    if (e.target != null) {
      const name = context?.symbolFor?.(e.target);
      text += '  → ' + (name || '0x' + e.target.toString(16).toUpperCase());
    }
    return text.replace(/\s+/g, ' ').trim();
  }
  return brief(mnemonic, operands, style, context || {});
}

export function supportsBeginnerInstructionNotes(architecture) {
  const arch = normalizeArchitecture(architecture);
  return arch === 'arm64' || arch === 'arm64e';
}
