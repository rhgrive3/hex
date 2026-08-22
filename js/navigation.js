/*
 * Lightweight location history for the code viewer.
 *
 * Panels keep their own parent/child history in ui.js. This class only tracks
 * actual viewer locations, so scrolling does not fill the history with noise.
 */

export class NavigationHistory {
  constructor({ limit = 40, onChange, onNavigate } = {}) {
    const numericLimit = Number(limit);
    this.limit = Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : 40;
    this.onChange = onChange || (() => {});
    this.onNavigate = onNavigate || (() => {});
    this.entries = [];
    this.index = -1;
  }

  reset(entry) {
    this.entries = entry ? [entry] : [];
    this.index = this.entries.length - 1;
    this.onChange(this.snapshot());
  }

  visit(entry) {
    if (!entry) return;
    const current = this.current();
    if (current && current.key === entry.key) {
      this.entries[this.index] = entry;
      this.onChange(this.snapshot());
      return;
    }
    this.entries.splice(this.index + 1);
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    this.onChange(this.snapshot());
  }

  back() { return this.move(-1); }
  forward() { return this.move(1); }

  move(delta) {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return false;
    this.index = next;
    const entry = this.current();
    this.onNavigate(entry);
    this.onChange(this.snapshot());
    return true;
  }

  current() { return this.entries[this.index] || null; }

  snapshot() {
    return {
      canBack: this.index > 0,
      canForward: this.index >= 0 && this.index < this.entries.length - 1,
      current: this.current(),
      length: this.entries.length,
    };
  }
}
