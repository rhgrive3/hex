/*
 * Application state. The UI reads from here, never from the DOM.
 * Nothing in this file touches the document.
 */

const DEFAULTS = {
  file: null,            // File handle (never uploaded, never mutated)
  fileInfo: null,        // { name, size, format, slices[], raw, warnings[] }
  sliceIndex: -1,        // index into fileInfo.slices, -1 for raw-only files
  architecture: null,    // 'ARM64' | 'x86_64' | …
  canDisassemble: false,
  regions: [],           // navigable regions of the active slice
  currentRegion: null,
  currentAddress: null,  // BigInt — top of the viewport
  displayMode: 'asm',    // 'asm' | 'hex'
  hexJoined: false,
  searchQuery: '',
  searchKind: 'asm',     // 'asm' | 'hex' | 'addr'
  selectedRow: -1,
  selectionStart: -1,    // inclusive row range while picking a range to copy
  selectionEnd: -1,
  theme: 'system',       // 'system' | 'light' | 'dark'
};

function defaultState() {
  return { ...DEFAULTS, regions: [] };
}

export class Store {
  constructor() {
    this.state = defaultState();
    this.listeners = new Set();
  }
  get(key) { return this.state[key]; }
  set(patch) {
    let changed = false;
    for (const k in patch) {
      if (this.state[k] !== patch[k]) { this.state[k] = patch[k]; changed = true; }
    }
    if (changed) for (const fn of this.listeners) fn(this.state, patch);
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  reset() { this.set(defaultState()); }
}

/* ── Persisted preferences (theme, hex grouping) ─────────────── */

const PREF_KEY = 'hexviewer.prefs.v1';

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return (p && typeof p === 'object') ? p : {};
  } catch { return {}; }
}

export function savePrefs(prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}
