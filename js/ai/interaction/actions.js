/*
 * Executing an answer.
 *
 * Every action the assistant offers ends in the workbench, not in more chat:
 * an address becomes a scrolled, highlighted row; a function becomes an open
 * function; a proposal becomes a decision. On a narrow layout the panel steps
 * out of the way after navigating, because an answer the user cannot see the
 * code for is not an answer.
 */
import { toast } from '../../ui.js';
import { pick } from '../../i18n.js';
import { showXrefs, showValueFlow } from '../../panels.js';

function narrow() {
  return typeof window !== 'undefined' && window.innerWidth < 900;
}

function goToCode(app, ui, addr, { select = false } = {}) {
  if (addr == null) return false;
  const moved = app.goToAddress(addr, { announce: true });
  if (!moved) return false;
  if (ui && ui.router) ui.router.navigate('/code/' + addr.toString());
  if (select) {
    const region = app.store.get('currentRegion');
    if (region) {
      const row = app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null;
      if (row != null) {
        app.viewer.select(row, false);
        app.store.set({ selectedRow: row });
      }
    }
  }
  return true;
}

/**
 * @param {object} app
 * @param {{ui: object, assistant: object}} deps
 * @returns {(action: object) => Promise<void>}
 */
export function createActionRunner(app, { ui, assistant } = {}) {
  return async function runAction(action) {
    if (!action) return;
    const addr = action.address != null ? action.address : null;
    switch (action.kind) {
      case 'open-function': {
        if (addr == null) return;
        app.goToFunction(addr);
        if (ui && ui.router) ui.router.navigate('/code/' + addr.toString());
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'open-address': {
        if (!goToCode(app, ui, addr, { select: true })) {
          toast(pick('そのアドレスは開けませんでした。', 'That address could not be opened.'));
          return;
        }
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'show-xrefs': {
        if (addr == null) return;
        showXrefs(app, addr);
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'show-callers':
      case 'show-callees': {
        if (addr == null || !ui || !ui.router) return;
        ui.router.navigate('/function/' + addr.toString() + '/calls');
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'trace-value': {
        if (addr == null) return;
        const semantic = app.semantic;
        const region = app.store.get('currentRegion');
        const model = semantic && semantic.model;
        const insn = model?.instructions?.find((i) => i.address === addr);
        const row = insn?.row ?? (app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null);
        if (model && row != null && Number.isFinite(row)) showValueFlow(app, model, row, region);
        else if (ui && ui.router) ui.router.navigate('/function/' + addr.toString() + '/overview');
        if (narrow() && assistant) assistant.collapse();
        return;
      }
      case 'run-agent': {
        if (!assistant) return;
        assistant.open();
        assistant.ask(action.target || action.label, { mode: 'agent' });
        return;
      }
      case 'review-proposal': {
        if (assistant) assistant.focusProposal(action.target);
        return;
      }
      default:
        toast(pick('この操作にはまだ対応していません。', 'That action is not supported yet.'));
    }
  };
}

export default createActionRunner;
