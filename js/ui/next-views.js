/*
 * "Now show me that another way."
 *
 * Every analysis result names a routine, and the next thing a reader wants is
 * that routine in a different form: as pseudo-C, as a flow diagram, as its
 * callers, or as the raw instructions. Until this module existed each result
 * sheet invented its own two or three buttons, so the way from a finding to
 * the decompiler ran through the function index — the reader had to go and
 * search for the address they had just been shown.
 *
 * One vocabulary, used by every result surface. The destinations are the
 * canonical workspace tabs (`/function/:address/:tab`); the legacy sheets are
 * only the fallback for a shell with no router.
 *
 * Pure data and dispatch — no DOM. Tested by tests/ui/next-views.mjs.
 */
/*
 * Order is the reading order, not a menu: overview answers "what is this",
 * pseudo-C answers "how", the diagram answers "in what order", calls answer
 * "who wanted this", and the assembly is the ground truth underneath.
 */
export const FUNCTION_VIEWS = Object.freeze([
  {
    id: 'report', route: '/function/:address/overview', legacy: 'report',
    ja: '関数の概要', en: 'Function overview',
    hintJa: 'この関数が何をしているか', hintEn: 'What this routine does',
  },
  {
    id: 'pseudocode', route: '/function/:address/pseudocode', legacy: 'decompiler', needsDisassembly: true,
    ja: '疑似Cで読む', en: 'Read as pseudo-C',
    hintJa: 'C 言語風に書き直した形', hintEn: 'The routine rewritten C-style',
  },
  {
    id: 'flow', route: '/function/:address/flow', legacy: 'cfg', needsDisassembly: true,
    ja: '流れを図で見る', en: 'See the flow diagram',
    hintJa: '分岐とループのつながり', hintEn: 'How branches and loops connect',
  },
  {
    id: 'calls', route: '/function/:address/calls', legacy: 'callGraph',
    ja: '呼び出しを見る', en: 'See the calls',
    hintJa: 'どこから呼ばれ、何を呼ぶか', hintEn: 'Who calls it, and what it calls',
  },
  {
    id: 'evidence', route: '/function/:address/evidence', legacy: null,
    ja: '根拠を確かめる', en: 'Check the evidence',
    hintJa: 'なぜそう言えるのか', hintEn: 'Why this can be claimed',
  },
  {
    id: 'assembly', route: '/code/:address', legacy: 'code',
    ja: 'アセンブリを見る', en: 'Open the assembly',
    hintJa: '元の命令列そのもの', hintEn: 'The instructions themselves',
  },
]);

const VIEW_MAP = new Map(FUNCTION_VIEWS.map((item) => [item.id, item]));

export function viewLabel(id, ja = true) {
  const item = VIEW_MAP.get(id);
  if (!item) return '';
  return ja ? item.ja : item.en;
}

function addressOf(address) {
  if (address == null) return null;
  try { return BigInt(address).toString(); } catch { return null; }
}

/**
 * The views offered next to one result.
 *
 * `include` fixes the order when a surface wants only some of them; `exclude`
 * drops the view the reader is already looking at, because a button back to
 * the screen you are on is noise. An unavailable view is kept and disabled
 * with its reason: silently dropping it reads as a missing feature, and the
 * reason ("this CPU has no pseudo-C") is the honest answer.
 */
export function functionViews({ address, capability = {}, include, exclude = [], primary = 'report', ja = true } = {}) {
  const decimal = addressOf(address);
  const skip = new Set(exclude);
  const wanted = Array.isArray(include) && include.length
    ? include.map((id) => VIEW_MAP.get(id)).filter(Boolean)
    : FUNCTION_VIEWS;
  const canDisassemble = capability.canDisassemble !== false;
  return wanted.filter((item) => !skip.has(item.id)).map((item) => {
    const unavailable = decimal == null
      ? (ja ? 'この結果には関数のアドレスがありません。' : 'This result has no function address.')
      : (item.needsDisassembly && !canDisassemble
        ? (ja ? 'この CPU では疑似Cと図を作れません。' : 'Pseudo-C and diagrams are unavailable for this CPU.')
        : '');
    return {
      id: item.id,
      label: ja ? item.ja : item.en,
      hint: ja ? item.hintJa : item.hintEn,
      route: decimal == null ? null : item.route.replace(':address', decimal),
      legacy: item.legacy,
      primary: item.id === primary,
      available: !unavailable,
      reason: unavailable,
      address: decimal,
    };
  });
}

/**
 * Open one view.
 *
 * The router is the canonical path. `legacy` is the same destination as a
 * sheet, for a shell that has no product router; when neither can serve the
 * view, this reports the failure rather than pretending something opened.
 */
export function openFunctionView(view, { router, legacy = {}, address } = {}) {
  if (!view || !view.available) return false;
  const target = address == null ? view.address : addressOf(address);
  if (target == null) return false;
  if (router && typeof router.navigate === 'function' && view.route) {
    try {
      const navigated = router.navigate(view.route);
      return navigated !== false || router.current?.fullPath === view.route;
    } catch {
      return false;
    }
  }
  const fallback = view.legacy ? legacy[view.legacy] : null;
  if (typeof fallback !== 'function') return false;
  fallback(target);
  return true;
}

export default { FUNCTION_VIEWS, functionViews, openFunctionView, viewLabel };
