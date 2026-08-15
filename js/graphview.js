/* Graph rendering and CFG/Call Graph adapters. Routing lives in graph-routing.js. */

import {
  LINE_H, PAD_X, PAD_Y, MAX_LINES, MAX_CHARS,
  layoutNodes, routeEdges, roundedOrthogonalPath, graphRoutingDiagnostics,
} from './graph-routing.js';

export { graphRoutingDiagnostics };

const NS = 'http://www.w3.org/2000/svg';
let graphSerial = 0;

function svgEl(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
  return n;
}

/**
 * @param {Array} nodes [{id, title, lines:[string], kind, onTap}]
 * @param {Array} edges [{from, to, kind:'true'|'false'|'jump'|'back'|'call', label}]
 * @param {object} opts {height, onNode}
 * @returns {HTMLElement} スクロール・拡大縮小できる入れ物
 */
export function renderGraph(nodes, edges, opts) {
  const o = opts || {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layout = layoutNodes(nodes, edges, byId);
  const routes = routeEdges(edges, layout);

  const wrap = document.createElement('div');
  wrap.className = 'graphwrap';
  const svg = svgEl('svg', {
    class: 'graph',
    width: layout.width, height: layout.height,
    viewBox: '0 0 ' + layout.width + ' ' + layout.height,
  });

  /* 同じページに複数グラフがあっても marker id が衝突しない。 */
  const markerPrefix = 'g' + (++graphSerial) + '-';
  const defs = svgEl('defs');
  for (const [id, cls] of [['ga', 'g-arrow'], ['gt', 'g-arrow true'], ['gf', 'g-arrow false'], ['gb', 'g-arrow back']]) {
    const marker = svgEl('marker', {
      id: markerPrefix + id, viewBox: '0 0 10 10', refX: 8, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
      markerUnits: 'strokeWidth',
    });
    marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls }));
    defs.append(marker);
  }
  svg.append(defs);

  /* 線を先に描く。各線には halo と太い透明 hit-area を持たせる。 */
  for (const route of routes) {
    const e = route.edge;
    const cls = 'g-edge ' + (e.kind || 'jump');
    const markerId = e.kind === 'true' ? 'gt' : e.kind === 'false' ? 'gf' : e.kind === 'back' ? 'gb' : 'ga';
    const d = roundedOrthogonalPath(route.points);
    const group = svgEl('g', { class: 'g-edge-group' });

    const hit = svgEl('path', {
      d, fill: 'none', stroke: 'transparent', 'stroke-width': 14,
      'pointer-events': 'stroke',
    });
    const halo = svgEl('path', {
      d, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': e.kind === 'back' ? 7 : 5.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none',
    });
    const path = svgEl('path', {
      d, class: cls,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'marker-end': 'url(#' + markerPrefix + markerId + ')',
      'pointer-events': 'none',
    });

    const baseWidth = e.kind === 'back' ? 2.5 : 1.6;
    const emphasize = () => {
      path.style.strokeWidth = String(baseWidth + 1.6);
      halo.style.strokeWidth = String((e.kind === 'back' ? 7 : 5.5) + 2.4);
    };
    const normalize = () => {
      path.style.strokeWidth = '';
      halo.style.strokeWidth = String(e.kind === 'back' ? 7 : 5.5);
    };
    hit.addEventListener('pointerenter', emphasize);
    hit.addEventListener('pointerleave', normalize);
    hit.addEventListener('focus', emphasize);
    hit.addEventListener('blur', normalize);

    group.append(hit, halo, path);

    if (e.label && route.label) {
      const w = e.label.length * 12 + 10;
      group.append(svgEl('rect', {
        x: route.label.x - w / 2, y: route.label.y - 12,
        width: w, height: 16, rx: 4, class: 'g-labelbg',
      }));
      const mid = svgEl('text', { x: route.label.x, y: route.label.y, class: 'g-label' });
      mid.textContent = e.label;
      group.append(mid);
    }
    svg.append(group);
  }

  /* 箱 */
  for (const n of nodes) {
    const p = layout.pos.get(n.id);
    if (!p) continue;
    const label = [n.title, ...(n.lines || []).slice(0, 2)].filter(Boolean).join(' — ');
    const g = svgEl('g', {
      class: 'g-node' + (n.kind ? ' ' + n.kind : ''), tabindex: 0,
      role: n.onTap || o.onNode ? 'button' : 'img', 'aria-label': label || '関係図のノード',
    });
    g.append(svgEl('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 8, class: 'g-box' }));
    if (n.title) {
      const t = svgEl('text', { x: p.x + PAD_X, y: p.y + PAD_Y + 12, class: 'g-title' });
      t.textContent = n.title;
      g.append(t);
    }
    const start = p.y + PAD_Y + (n.title ? LINE_H + 12 : 12);
    (n.lines || []).slice(0, MAX_LINES).forEach((text, i) => {
      const t = svgEl('text', { x: p.x + PAD_X, y: start + i * LINE_H, class: 'g-line' });
      t.textContent = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1) + '…' : text;
      g.append(t);
    });
    if ((n.lines || []).length > MAX_LINES) {
      const t = svgEl('text', { x: p.x + PAD_X, y: start + MAX_LINES * LINE_H, class: 'g-line dim' });
      t.textContent = '… ほか ' + (n.lines.length - MAX_LINES) + ' 行';
      g.append(t);
    }
    if (n.onTap || o.onNode) {
      g.style.cursor = 'pointer';
      const activate = () => (n.onTap ? n.onTap() : o.onNode(n));
      g.addEventListener('click', activate);
      g.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      });
    }
    svg.append(g);
  }

  wrap.append(svg);
  attachPanZoom(wrap, svg, layout);
  return wrap;
}

/* ── 指で動かす・広げる ─────────────────────────────────── */

function attachPanZoom(wrap, svg, layout) {
  const MIN = 0.2, MAX = 3;
  let scale = 1;

  const apply = () => {
    svg.setAttribute('width', Math.round(layout.width * scale));
    svg.setAttribute('height', Math.round(layout.height * scale));
    if (pctBtn) pctBtn.textContent = Math.round(scale * 100) + '%';
  };

  const zoomTo = (next, cx, cy) => {
    const box = wrap.getBoundingClientRect();
    const px = (cx == null ? box.width / 2 : cx - box.left);
    const py = (cy == null ? box.height / 2 : cy - box.top);
    const gx = (wrap.scrollLeft + px) / scale;
    const gy = (wrap.scrollTop + py) / scale;
    scale = Math.max(MIN, Math.min(MAX, next));
    apply();
    wrap.scrollLeft = gx * scale - px;
    wrap.scrollTop = gy * scale - py;
  };

  const fit = () => {
    const w = wrap.clientWidth || 320;
    const h = wrap.clientHeight || 320;
    scale = Math.max(MIN, Math.min(1, Math.min((w - 24) / layout.width, (h - 24) / layout.height)));
    apply();
    wrap.scrollLeft = Math.max(0, (layout.width * scale - w) / 2);
    wrap.scrollTop = 0;
  };

  const bar = document.createElement('div');
  bar.className = 'graph-tools';
  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', fn);
    return b;
  };
  const pctBtn = mk('100%', '等倍に戻す', () => zoomTo(1));
  bar.append(
    mk('－', '縮小', () => zoomTo(scale - 0.2)),
    pctBtn,
    mk('＋', '拡大', () => zoomTo(scale + 0.2)),
    mk('全体', '全体を画面に収める', fit));
  wrap.append(bar);

  const points = new Map();
  let pinch = 0;
  let last = null;
  let suppressClick = false;
  let multiTouchGesture = false;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('.graph-tools')) return;
    if (points.size === 0) { suppressClick = false; multiTouchGesture = false; }
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) {
      last = { x: e.clientX, y: e.clientY, moved: false };
      wrap.classList.add('dragging');
      wrap.setPointerCapture(e.pointerId);
    } else if (points.size === 2) {
      multiTouchGesture = true;
      pinch = spread(points);
    }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size >= 2) {
      const now = spread(points);
      if (pinch > 0 && now > 0) {
        const c = centre(points);
        zoomTo(scale * (now / pinch), c.x, c.y);
      }
      pinch = now;
      e.preventDefault();
      return;
    }
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) last.moved = true;
    wrap.scrollLeft -= dx;
    wrap.scrollTop -= dy;
    last.x = e.clientX;
    last.y = e.clientY;
    e.preventDefault();
  });
  const release = (e) => {
    points.delete(e.pointerId);
    if (points.size < 2) pinch = 0;
    if (!points.size) {
      wrap.classList.remove('dragging');
      suppressClick = !!(last && last.moved) || multiTouchGesture;
      last = null;
    }
  };
  wrap.addEventListener('pointerup', release);
  wrap.addEventListener('pointercancel', release);
  wrap.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  wrap.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      zoomTo(scale * (e.deltaY > 0 ? 0.9 : 1.1), e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    wrap.scrollLeft += e.deltaX;
    wrap.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  requestAnimationFrame(fit);
  return { apply, fit, zoomTo };
}

function spread(points) {
  const p = Array.from(points.values());
  if (p.length < 2) return 0;
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}

function centre(points) {
  const p = Array.from(points.values());
  return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
}

/** 図の下に置く凡例。線の意味を、色だけに頼らせない。 */
export function graphLegend(kind) {
  const wrap = document.createElement('div');
  wrap.className = 'graph-legend';
  const add = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.append(document.createElement('i'));
    s.append(document.createTextNode(text));
    wrap.append(s);
  };
  if (kind === 'call') {
    add('lg-call', '呼んでいる向き（上が呼ぶ側・下が呼ばれる側）');
  } else {
    add('lg-true', '条件が成り立つとき');
    add('lg-false', '成り立たないとき');
    add('lg-back', 'ここへ戻る（ループ）');
  }
  const tip = document.createElement('span');
  tip.textContent = '押したまま動かす／2 本指でつまむと拡大縮小';
  wrap.append(tip);
  return wrap;
}

/* ── モデルから図の材料を作る ──────────────────────────── */

/**
 * 関数 1 つの制御フローグラフ。
 * @param {object} model  Semantic Model
 * @param {object} opts {rowOfAddress, addrOfRow, brief(insn) → 1 行の説明, onNode}
 */
export function cfgGraph(model, opts) {
  const o = opts || {};
  const blocks = model.basicBlocks || [];
  const byRow = new Map();
  for (const i of model.instructions) byRow.set(i.row, i);

  const nodeOfRow = (row) => {
    for (const b of blocks) if (row >= b.startRow && row <= b.endRow) return b.index;
    return -1;
  };

  const nodes = blocks.map((b) => {
    const lines = [];
    for (const r of b.rows) {
      const insn = byRow.get(r);
      if (!insn) continue;
      lines.push(o.text ? o.text(insn) : (insn.mnemonic + ' ' + insn.operands).trim());
    }
    const addr = byRow.get(b.startRow) ? byRow.get(b.startRow).address : null;
    return {
      id: b.index,
      title: (addr != null ? '0x' + addr.toString(16).toUpperCase() : '#' + b.index) +
        (b.isLoopHeader ? '  ← ここへ戻ってくる' : ''),
      lines,
      kind: b.isLoopHeader ? 'loop' : (b.index === 0 ? 'entry' : ''),
      addr,
      onTap: o.onNode ? () => o.onNode(b, addr) : null,
    };
  });

  const edges = [];
  const backEdges = new Set((model.backEdges || []).map((e) => `${e.from}:${e.to}`));
  const isBackEdge = (fromBlock, toBlock, terminalRow) => {
    if (toBlock == null || toBlock < 0) return false;
    const target = blocks[toBlock];
    return !!target && backEdges.has(`${terminalRow}:${target.startRow}`);
  };
  for (const b of blocks) {
    const last = [...b.rows].reverse().map((r) => byRow.get(r)).find((i) => i && !i.data);
    if (!last) continue;
    const base = (last.mnemonic || '').toLowerCase();
    if (last.isReturn || last.isTailCall) continue;
    const targetRow = last.branchTarget != null && o.rowOfAddress ? o.rowOfAddress(last.branchTarget) : null;
    const ti = targetRow != null ? nodeOfRow(targetRow) : -1;
    const next = b.index + 1 < blocks.length ? b.index + 1 : null;

    if (last.isConditional || /^(cbz|cbnz|tbz|tbnz)$/.test(base) || /^b\./.test(base)) {
      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: isBackEdge(b.index, ti, last.row) ? 'back' : 'true', label: '成り立つ' });
      if (next != null) edges.push({ from: b.index, to: next, kind: 'false', label: '成り立たない' });
      continue;
    }
    if (base === 'b') {
      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: isBackEdge(b.index, ti, last.row) ? 'back' : 'jump' });
      continue;
    }
    if (next != null) edges.push({ from: b.index, to: next, kind: 'jump' });
  }
  return { nodes, edges };
}

/**
 * 呼び出しグラフ。中心の関数から、呼ぶ側（上）と呼ばれる側（下）へ広げる。
 * @param {object} program ProgramIndex
 * @param {object} symbols SymbolIndex
 * @param {BigInt} addr 中心の関数
 * @param {object} opts {depth, limit, label(addr), onNode}
 */
export function callGraph(program, symbols, addr, opts) {
  const o = opts || {};
  const depth = o.depth || 1;
  const limit = o.limit || 8;
  const label = o.label || ((a) => (symbols && symbols.nameAt(a)) || 'sub_' + a.toString(16).toUpperCase());

  const nodes = [];
  const edges = [];
  const seen = new Map();
  const idOf = (a) => a.toString();

  const add = (a, kind) => {
    const id = idOf(a);
    if (seen.has(id)) return id;
    seen.set(id, true);
    nodes.push({
      id, title: null, lines: [label(a)], kind,
      addr: a,
      onTap: o.onNode ? () => o.onNode(a) : null,
    });
    return id;
  };

  add(addr, 'entry');

  let frontier = [addr];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const a of frontier) {
      const callers = program ? program.callersOf(a, limit) : [];
      for (const c of callers) {
        const start = c.addr;
        if (start == null) continue;
        add(start, 'caller');
        edges.push({ from: idOf(start), to: idOf(a), kind: 'call' });
        next.push(start);
      }
    }
    frontier = next;
  }

  frontier = [addr];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const a of frontier) {
      const range = program ? program.functionRange(a) : null;
      if (!range) continue;
      const callees = program.calleesOf(range.start, range.end, limit) || [];
      for (const c of callees) {
        const target = c.addr;
        if (target == null) continue;
        add(target, 'callee');
        edges.push({ from: idOf(a), to: idOf(target), kind: 'call' });
        next.push(target);
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}
