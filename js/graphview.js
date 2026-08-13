/*
 * 図（グラフ）を描く。
 *
 *  - 制御フローグラフ（CFG）… 関数の中の「道の分かれ方」
 *  - 呼び出しグラフ（Call Graph）… 関数どうしの「誰が誰を呼ぶか」
 *
 * IDA の Graph view と同じ絵です。文字だけの一覧より、
 * 「ここで 2 つに分かれて、ここで合流する」が一目で分かります。
 *
 * 外部ライブラリは使わず、SVG を直接組み立てます（読み込みが速く、オフラインでも動く）。
 * 配置は層（レイヤ）方式:
 *   1. 入口からの深さで段を決める
 *   2. 同じ段の中で左から順に並べる
 *   3. 線は「出口の下 → 入口の上」へ、途中で 1 回曲げて引く
 */

const CHAR_W = 7.2;          // 等幅フォント 12px のおおよその字幅
const LINE_H = 16;
const PAD_X = 10;
const PAD_Y = 8;
const GAP_X = 28;
const GAP_Y = 46;
const MAX_LINES = 14;        // 1 つの箱に入れる行数の上限
const MAX_CHARS = 46;

const NS = 'http://www.w3.org/2000/svg';

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

  const wrap = document.createElement('div');
  wrap.className = 'graphwrap';
  const svg = svgEl('svg', {
    class: 'graph',
    width: layout.width, height: layout.height,
    viewBox: '0 0 ' + layout.width + ' ' + layout.height,
  });

  /* 矢印の先端 */
  const defs = svgEl('defs');
  for (const [id, cls] of [['ga', 'g-arrow'], ['gt', 'g-arrow true'], ['gf', 'g-arrow false'], ['gb', 'g-arrow back']]) {
    const marker = svgEl('marker', {
      id, viewBox: '0 0 10 10', refX: 8, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
    });
    marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls }));
    defs.append(marker);
  }
  svg.append(defs);

  /* 線を先に描く（箱の下に来るように） */
  for (const e of edges) {
    const a = layout.pos.get(e.from);
    const b = layout.pos.get(e.to);
    if (!a || !b) continue;
    const cls = 'g-edge ' + (e.kind || 'jump');
    const path = svgEl('path', {
      d: edgePath(a, b),
      class: cls,
      'marker-end': 'url(#' + (e.kind === 'true' ? 'gt' : e.kind === 'false' ? 'gf' : e.kind === 'back' ? 'gb' : 'ga') + ')',
    });
    svg.append(path);
    if (e.label) {
      const mid = svgEl('text', {
        x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h + b.y) / 2, class: 'g-label',
      });
      mid.textContent = e.label;
      svg.append(mid);
    }
  }

  /* 箱 */
  for (const n of nodes) {
    const p = layout.pos.get(n.id);
    if (!p) continue;
    const g = svgEl('g', { class: 'g-node' + (n.kind ? ' ' + n.kind : ''), tabindex: 0 });
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
      g.addEventListener('click', () => (n.onTap ? n.onTap() : o.onNode(n)));
    }
    svg.append(g);
  }

  wrap.append(svg);
  attachPanZoom(wrap, svg, layout);
  return wrap;
}

/* ── 配置 ───────────────────────────────────────────────── */

function layoutNodes(nodes, edges, byId) {
  const succ = new Map();
  const indeg = new Map();
  for (const n of nodes) { succ.set(n.id, []); indeg.set(n.id, 0); }
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.kind === 'back') continue;
    succ.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

  /* 段を決める: 入口から順に、親より 1 つ下へ */
  const rank = new Map();
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  if (!queue.length && nodes.length) queue.push(nodes[0].id);
  for (const id of queue) rank.set(id, 0);
  let guard = 0;
  const work = queue.slice();
  while (work.length && guard++ < 20000) {
    const id = work.shift();
    for (const s of succ.get(id) || []) {
      const r = (rank.get(id) || 0) + 1;
      if (!rank.has(s) || rank.get(s) < r) {
        if ((rank.get(s) || 0) > nodes.length) continue;      // 環に入り込まない
        rank.set(s, r);
        work.push(s);
      }
    }
  }
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

  /* 箱の大きさ */
  const size = new Map();
  for (const n of nodes) {
    const lines = (n.lines || []).slice(0, MAX_LINES + 1);
    const longest = Math.max(
      n.title ? n.title.length : 0,
      ...lines.map((l) => Math.min(l.length, MAX_CHARS)), 8);
    size.set(n.id, {
      w: Math.round(longest * CHAR_W + PAD_X * 2),
      h: PAD_Y * 2 + (n.title ? LINE_H : 0) + Math.max(1, lines.length) * LINE_H + 4,
    });
  }

  /* 段ごとに横並び */
  const rows = new Map();
  for (const n of nodes) {
    const r = rank.get(n.id);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(n.id);
  }
  const pos = new Map();
  let y = 20;
  let width = 200;
  const ranksSorted = Array.from(rows.keys()).sort((a, b) => a - b);
  for (const r of ranksSorted) {
    const ids = rows.get(r);
    let x = 20;
    let tallest = 0;
    for (const id of ids) {
      const s = size.get(id);
      pos.set(id, { x, y, w: s.w, h: s.h });
      x += s.w + GAP_X;
      tallest = Math.max(tallest, s.h);
    }
    width = Math.max(width, x);
    y += tallest + GAP_Y;
  }
  return { pos, width: width + 20, height: y + 20 };
}

function edgePath(a, b) {
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y;
  if (y2 >= y1) {
    const mid = (y1 + y2) / 2;
    return 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + mid + ' L ' + x2 + ' ' + mid + ' L ' + x2 + ' ' + (y2 - 2);
  }
  /* 上へ戻る線（ループ）は横に回り込ませる */
  const side = Math.max(x1, x2) + 40;
  return 'M ' + x1 + ' ' + y1 + ' L ' + side + ' ' + y1 + ' L ' + side + ' ' + (b.y + b.h / 2) +
    ' L ' + (b.x + b.w + 2) + ' ' + (b.y + b.h / 2);
}

/* ── 指で動かす・広げる ─────────────────────────────────── */

function attachPanZoom(wrap, svg, layout) {
  let scale = 1;
  const apply = () => {
    svg.setAttribute('width', Math.round(layout.width * scale));
    svg.setAttribute('height', Math.round(layout.height * scale));
  };
  const bar = document.createElement('div');
  bar.className = 'graph-tools';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  bar.append(
    mk('－', () => { scale = Math.max(0.35, scale - 0.15); apply(); }),
    mk('＋', () => { scale = Math.min(2.5, scale + 0.15); apply(); }),
    mk('全体', () => {
      const w = wrap.clientWidth || 320;
      scale = Math.min(1, Math.max(0.3, (w - 16) / layout.width));
      apply();
    }));
  wrap.append(bar);

  /* 最初は画面の幅に合わせておく（横スクロールで迷子にならないように） */
  requestAnimationFrame(() => {
    const w = wrap.clientWidth || 320;
    if (layout.width > w) { scale = Math.max(0.3, (w - 16) / layout.width); apply(); }
  });
  return apply;
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
  for (const b of blocks) {
    const last = [...b.rows].reverse().map((r) => byRow.get(r)).find((i) => i && !i.data);
    if (!last) continue;
    const base = (last.mnemonic || '').toLowerCase();
    if (last.isReturn || last.isTailCall) continue;
    const targetRow = last.branchTarget != null && o.rowOfAddress ? o.rowOfAddress(last.branchTarget) : null;
    const ti = targetRow != null ? nodeOfRow(targetRow) : -1;
    const next = b.index + 1 < blocks.length ? b.index + 1 : null;

    if (last.isConditional || /^(cbz|cbnz|tbz|tbnz)$/.test(base) || /^b\./.test(base)) {
      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: ti <= b.index ? 'back' : 'true', label: '成り立つ' });
      if (next != null) edges.push({ from: b.index, to: next, kind: 'false', label: '成り立たない' });
      continue;
    }
    if (base === 'b') {
      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: ti <= b.index ? 'back' : 'jump' });
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

  /* 呼ぶ側 */
  let frontier = [addr];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const a of frontier) {
      const callers = program ? program.callersOf(a, limit) : [];
      for (const c of callers) {
        const start = c.addr;                     // 呼び出し元の関数の先頭
        if (start == null) continue;
        add(start, 'caller');
        edges.push({ from: idOf(start), to: idOf(a), kind: 'call' });
        next.push(start);
      }
    }
    frontier = next;
  }

  /* 呼ばれる側 */
  frontier = [addr];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const a of frontier) {
      const range = program ? program.functionRange(a) : null;
      if (!range) continue;
      const callees = program.calleesOf(range.start, range.end, limit) || [];
      for (const c of callees) {
        const target = c.addr;                    // 呼んでいる先
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
