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

const CHAR_W = 7.9;          // 等幅フォント 12.5px のおおよその字幅
const LINE_H = 18;
const PAD_X = 12;
const PAD_Y = 10;
const GAP_X = 34;
const GAP_Y = 58;
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
      d: edgePath(a, b, detourFor(a, b, layout)),
      class: cls,
      'marker-end': 'url(#' + (e.kind === 'true' ? 'gt' : e.kind === 'false' ? 'gf' : e.kind === 'back' ? 'gb' : 'ga') + ')',
    });
    svg.append(path);
    if (e.label) {
      /* 線の上に字を直に置くと読めない。下地を敷いてから書く。
         横へ逃がした線は、真ん中ではなく出口のすぐ下に置く（線とずれないように）。 */
      const detour = detourFor(a, b, layout);
      /* 逃がした線は、まっすぐ降りる線と札がぶつかる。逃げた先の縦の道に置く。 */
      const cx = detour != null ? detour : (a.x + a.w / 2 + b.x + b.w / 2) / 2;
      const cy = (a.y + a.h + b.y) / 2;
      const w = e.label.length * 12 + 10;
      svg.append(svgEl('rect', {
        x: cx - w / 2, y: cy - 12, width: w, height: 16, rx: 4, class: 'g-labelbg',
      }));
      const mid = svgEl('text', { x: cx, y: cy, class: 'g-label' });
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
  const ranksSorted = Array.from(rows.keys()).sort((a, b) => a - b);

  /*
   * 段の中の並び順を決める。
   *
   * 出てきた順のまま置くと、線が何本も交差して「どこから来た線か」が
   * 追えなくなる。親の位置の平均（重心）で並べ替えると、交差はぐっと減る。
   * 上から下、下から上へ数回ならすだけで、目で追える絵になる。
   */
  const order = new Map();                 // id → 段の中の位置
  for (const r of ranksSorted) rows.get(r).forEach((id, i) => order.set(id, i));

  const pred = new Map();
  for (const n of nodes) pred.set(n.id, []);
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.kind === 'back') continue;
    pred.get(e.to).push(e.from);
  }
  const mean = (ids) => (ids.length
    ? ids.reduce((s, id) => s + (order.get(id) != null ? order.get(id) : 0), 0) / ids.length
    : null);

  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 0;
    const seq = down ? ranksSorted : ranksSorted.slice().reverse();
    for (const r of seq) {
      const ids = rows.get(r);
      if (ids.length < 2) continue;
      const key = new Map();
      for (const id of ids) {
        const neighbours = down ? pred.get(id) : (succ.get(id) || []);
        const m = mean(neighbours.filter((x) => rank.get(x) !== r));
        key.set(id, m == null ? order.get(id) : m);
      }
      ids.sort((a, b) => key.get(a) - key.get(b) || order.get(a) - order.get(b));
      ids.forEach((id, i) => order.set(id, i));
    }
  }

  /* いちばん広い段を基準に、どの段も中央にそろえる */
  const rowWidth = (ids) => ids.reduce((s, id) => s + size.get(id).w, 0) +
    GAP_X * Math.max(0, ids.length - 1);
  let width = 200;
  for (const r of ranksSorted) width = Math.max(width, rowWidth(rows.get(r)));

  const pos = new Map();
  let y = 24;
  for (const r of ranksSorted) {
    const ids = rows.get(r);
    let x = 24 + (width - rowWidth(ids)) / 2;
    let tallest = 0;
    for (const id of ids) {
      const s = size.get(id);
      pos.set(id, { x, y, w: s.w, h: s.h });
      x += s.w + GAP_X;
      tallest = Math.max(tallest, s.h);
    }
    y += tallest + GAP_Y;
  }
  /* 右の余白は、段を飛び越す線を逃がす通り道にも使う。 */
  return { pos, width: width + 80, height: y + 24 };
}

/*
 * 段を飛び越す線は、間の箱を突き抜けてしまう。
 *
 * cbz で 2 つ先へ飛ぶ形（if の中身を丸ごと飛ばす）はごくふつうに出てくるが、
 * まっすぐ引くと途中の箱の裏に隠れて、線が 1 本消えたように見える。
 * 間に箱があるときは、右へ逃がしてから降ろす。
 *
 * @returns {number|null} 逃がす先の x（要らなければ null）
 */
function detourFor(a, b, layout) {
  const top = a.y + a.h;
  const bottom = b.y;
  if (bottom <= top) return null;                 // 戻る線は別扱い
  let hit = false;
  let right = Math.max(a.x + a.w, b.x + b.w);
  for (const p of layout.pos.values()) {
    if (p === a || p === b) continue;
    // その箱が、線の通る高さの帯にかかっているか
    if (p.y + p.h <= top + 1 || p.y >= bottom - 1) continue;
    hit = true;
    right = Math.max(right, p.x + p.w);
  }
  return hit ? right + 24 : null;
}

function edgePath(a, b, detour) {
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y;
  if (y2 >= y1) {
    if (detour != null) {
      const drop = y1 + 14;
      const rise = y2 - 14;
      return 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + drop + ' L ' + detour + ' ' + drop +
        ' L ' + detour + ' ' + rise + ' L ' + x2 + ' ' + rise + ' L ' + x2 + ' ' + (y2 - 2);
    }
    const mid = (y1 + y2) / 2;
    return 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + mid + ' L ' + x2 + ' ' + mid + ' L ' + x2 + ' ' + (y2 - 2);
  }
  /* 上へ戻る線（ループ）は横に回り込ませる */
  const side = Math.max(x1, x2) + 40;
  return 'M ' + x1 + ' ' + y1 + ' L ' + side + ' ' + y1 + ' L ' + side + ' ' + (b.y + b.h / 2) +
    ' L ' + (b.x + b.w + 2) + ' ' + (b.y + b.h / 2);
}

/* ── 指で動かす・広げる ─────────────────────────────────── */

/*
 * 図を、指とマウスの両方で扱えるようにする。
 *
 *   ・押したまま動かす      → 図をつかんで動かす（前は横スクロール棒だけだった）
 *   ・2 本指でつまむ        → その指の間を中心に拡大縮小
 *   ・ホイール / トラックパッド → 上下は移動、⌘・Ctrl 付きは拡大縮小
 *   ・＋ － 全体 100%        → 迷ったときに必ず戻れる場所
 *
 * 拡大は SVG の width/height を書き換える方式のまま。字がぼやけないし、
 * 中の座標も変わらないので、押せる場所がずれない。
 */
function attachPanZoom(wrap, svg, layout) {
  const MIN = 0.2, MAX = 3;
  let scale = 1;

  const apply = () => {
    svg.setAttribute('width', Math.round(layout.width * scale));
    svg.setAttribute('height', Math.round(layout.height * scale));
    if (pctBtn) pctBtn.textContent = Math.round(scale * 100) + '%';
  };

  /* 画面上のある点を動かさずに、倍率だけ変える。 */
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

  /* ── つかんで動かす ── */
  const points = new Map();
  let pinch = 0;
  let last = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('.graph-tools')) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) {
      last = { x: e.clientX, y: e.clientY, moved: false };
      wrap.classList.add('dragging');
      wrap.setPointerCapture(e.pointerId);
    } else if (points.size === 2) {
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
    if (!points.size) { wrap.classList.remove('dragging'); last = null; }
  };
  wrap.addEventListener('pointerup', release);
  wrap.addEventListener('pointercancel', release);
  /* 動かしたあとの指離しを、箱への「押した」と取り違えない。 */
  wrap.addEventListener('click', (e) => {
    if (last && last.moved) { e.stopPropagation(); e.preventDefault(); }
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

  /* 最初は全体が見える大きさで出す。迷子にならないところから始める。 */
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
