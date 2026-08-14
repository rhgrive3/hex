/*
 * Mode / style / scope vocabulary for the assistant surface.
 *
 * Pure data + resolution rules. The panel reads labels from here so that the
 * prompt layer and the UI can never disagree about which modes exist.
 */
import { MODES, STYLES, SCOPES } from '../prompts/compose.js';

export { MODES, STYLES, SCOPES };

export const MODE_ITEMS = Object.freeze([
  { id: 'chat', ja: 'チャット', en: 'Chat', hintJa: 'いまの画面について、すぐ答える', hintEn: 'Fast answers about what is on screen' },
  { id: 'agent', ja: 'エージェント', en: 'Agent', hintJa: '探して・たどって・確かめる', hintEn: 'Search, trace and verify' },
]);

export const STYLE_ITEMS = Object.freeze([
  { id: 'beginner', ja: 'やさしく', en: 'Beginner', hintJa: '結論から、専門用語は説明つき', hintEn: 'Conclusion first, terms explained' },
  { id: 'analyst', ja: '解析者', en: 'Analyst', hintJa: 'アドレスと事実を密に', hintEn: 'Dense addresses and facts' },
]);

export const SCOPE_ITEMS = Object.freeze([
  { id: 'auto', ja: '自動', en: 'Auto' },
  { id: 'function', ja: 'この関数', en: 'Current function' },
  { id: 'selection', ja: '選択範囲', en: 'Selection' },
  { id: 'neighborhood', ja: '呼び出し周辺', en: 'Neighborhood' },
  { id: 'binary', ja: 'バイナリ全体', en: 'Binary' },
  { id: 'project', ja: 'プロジェクト', en: 'Project' },
  { id: 'runtime', ja: '実行時', en: 'Runtime' },
]);

const byId = (items) => new Map(items.map((item) => [item.id, item]));
const MODE_MAP = byId(MODE_ITEMS);
const STYLE_MAP = byId(STYLE_ITEMS);
const SCOPE_MAP = byId(SCOPE_ITEMS);

export function modeLabel(id, ja = true) {
  const item = MODE_MAP.get(id) || MODE_ITEMS[0];
  return ja ? item.ja : item.en;
}
export function styleLabel(id, ja = true) {
  const item = STYLE_MAP.get(id) || STYLE_ITEMS[0];
  return ja ? item.ja : item.en;
}
export function scopeLabel(id, ja = true) {
  const item = SCOPE_MAP.get(id) || SCOPE_ITEMS[0];
  return ja ? item.ja : item.en;
}

/**
 * What Auto means right now.
 *
 * Auto is not a scope of its own at investigation time: it resolves to the
 * narrowest scope the workbench can actually supply, so a question asked with
 * nothing open cannot silently become a whole-binary sweep in Chat mode.
 */
export function resolveScope(scope, state = {}) {
  if (scope && scope !== 'auto' && SCOPES.includes(scope)) return scope;
  if (state.selection) return 'selection';
  if (state.functionAddress != null) return 'function';
  if (state.fileOpen) return 'binary';
  return 'project';
}

export default { MODE_ITEMS, STYLE_ITEMS, SCOPE_ITEMS, resolveScope };
