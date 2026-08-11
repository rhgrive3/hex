/*
 * 制御フローグラフ — 「この関数はどう枝分かれして、どこへ帰るのか」。
 *
 * blocks.js が作った Basic Block を辺でつなぎ、
 * if / else / ループ / 途中で帰る（early return）/ 異常時の道 を見分ける。
 *
 * 初心者に見せたいのは、命令の並びではなく道の形:
 *
 *     開始
 *      ↓
 *     条件判定
 *      ├─ 合えば → 処理A ┐
 *      └─ 合わねば → 処理B ┘→ 合流 → 終了
 *
 * ここも日本語は作らない。形と根拠だけを返す。
 * 行き先が実行時に決まる分岐 (br) は「分からない」として残す。埋めない。
 */
import { ROLE } from './blocks.js';

export const EDGE = {
  FALL: 'fall',        // そのまま次の行へ
  TAKEN: 'taken',      // 条件に合ったとき飛ぶ先
  JUMP: 'jump',        // 無条件に飛ぶ先
  UNKNOWN: 'unknown',  // 行き先が実行時に決まる
};

/**
 * @param {object} model buildSemanticModel の結果
 * @param {object} opts  { rowOfAddress(addr) }
 */
export function buildCfg(model, opts) {
  const o = opts || {};
  const rowOf = o.rowOfAddress || (() => null);
  const blocks = model.basicBlocks || [];
  const insnByRow = new Map();
  for (const i of model.instructions || []) insnByRow.set(i.row, i);

  const blockAtRow = (row) => {
    for (let i = 0; i < blocks.length; i++) {
      if (row >= blocks[i].startRow && row <= blocks[i].endRow) return i;
    }
    return -1;
  };

  const nodes = blocks.map((b, i) => ({
    index: i,
    startRow: b.startRow,
    endRow: b.endRow,
    rows: b.rows,
    succ: [],
    pred: [],
    isEntry: i === 0,
    isExit: false,
    isLoopHeader: !!b.isLoopHeader,
    isJoin: !!b.isJoin,
    terminator: null,
    role: null,
  }));

  const backEdges = [];

  for (const node of nodes) {
    // ブロックの最後にある「意味のある」命令を終端とする
    let term = null;
    for (let r = node.endRow; r >= node.startRow; r--) {
      const insn = insnByRow.get(r);
      if (insn && !insn.data) { term = insn; break; }
    }
    // br xN のように、行き先がレジスタで決まる分岐。ここは「分からない」を守る。
    const indirect = !!term && term.isBranch && !term.isCall &&
      term.branchTarget == null && !term.isReturn && !term.isConditional;
    node.terminator = term ? {
      row: term.row, address: term.address, mnemonic: term.mnemonic,
      conditional: !!term.isConditional, isReturn: !!term.isReturn,
      target: term.branchTarget != null ? term.branchTarget : null,
      indirect,
    } : null;

    const next = node.index + 1 < nodes.length ? node.index + 1 : -1;
    if (!term) {
      if (next >= 0) node.succ.push({ to: next, kind: EDGE.FALL });
      continue;
    }
    if (term.isReturn) { node.isExit = true; continue; }

    const isUncond = term.isBranch && !term.isCall && !term.isConditional && !term.isReturn;
    if (term.branchTarget != null) {
      const trow = rowOf(term.branchTarget);
      const tblock = trow != null ? blockAtRow(trow) : -1;
      if (tblock >= 0) {
        node.succ.push({ to: tblock, kind: isUncond ? EDGE.JUMP : EDGE.TAKEN, target: term.branchTarget });
        if (tblock <= node.index) backEdges.push({ from: node.index, to: tblock });
      } else {
        // 関数の外へ飛んでいる（末尾呼び出しなど）。ここで道は途切れる。
        node.succ.push({ to: -1, kind: EDGE.JUMP, target: term.branchTarget, outside: true });
        node.isExit = true;
      }
      if (!isUncond && next >= 0) node.succ.push({ to: next, kind: EDGE.FALL });
      continue;
    }
    if (indirect) {
      node.succ.push({ to: -1, kind: EDGE.UNKNOWN });
      node.isExit = true;
      continue;
    }
    if (next >= 0) node.succ.push({ to: next, kind: EDGE.FALL });
    else node.isExit = true;
  }

  for (const node of nodes) {
    for (const s of node.succ) {
      if (s.to >= 0 && nodes[s.to]) nodes[s.to].pred.push({ from: node.index, kind: s.kind });
    }
  }

  // Semantic Block の役割を、対応する Basic Block に添える（見出しに使う）
  for (const sb of model.semantic || []) {
    const i = blockAtRow(sb.startRow);
    if (i >= 0 && !nodes[i].role) nodes[i].role = sb.role;
  }

  return {
    nodes,
    backEdges,
    entry: nodes.length ? 0 : -1,
    exits: nodes.filter((n) => n.isExit).map((n) => n.index),
    shapes: classifyShapes(nodes, backEdges, model),
  };
}

/**
 * 道の形を見分ける。
 * 見分けられなかったものは何も返さない（「たぶん if」とは言わない）。
 */
function classifyShapes(nodes, backEdges, model) {
  const shapes = [];
  const errorBlocks = new Set();
  for (const sb of model.semantic || []) {
    if (sb.role === ROLE.ERROR_HANDLING) {
      for (const n of nodes) if (sb.startRow >= n.startRow && sb.startRow <= n.endRow) errorBlocks.add(n.index);
    }
  }

  for (const b of backEdges) {
    shapes.push({
      kind: 'loop', header: b.to, latch: b.from,
      startRow: nodes[b.to] ? nodes[b.to].startRow : null,
      endRow: nodes[b.from] ? nodes[b.from].endRow : null,
    });
  }

  for (const n of nodes) {
    const taken = n.succ.find((s) => s.kind === EDGE.TAKEN);
    const fall = n.succ.find((s) => s.kind === EDGE.FALL);
    if (!taken || !fall) continue;
    if (backEdges.some((b) => b.from === n.index)) continue;    // ループの判定はもう入れた

    const a = taken.to, c = fall.to;
    if (a < 0 || c < 0) continue;

    /*
     * どちらかの道がすぐ ret へ行くなら「途中で帰る」形。
     * 両方が帰る場合は、短いほうを「途中で帰る道」とみなす
     * （長いほうが本筋で、短いほうが打ち切りなのがふつう）。
     */
    const exitDistance = (start) => {
      let cur = start;
      for (let step = 0; step < 3 && cur >= 0 && nodes[cur]; step++) {
        if (nodes[cur].isExit) return step;
        const only = nodes[cur].succ.filter((s) => s.to >= 0);
        if (only.length !== 1) return -1;
        cur = only[0].to;
      }
      return -1;
    };
    const distA = exitDistance(a);
    const distC = exitDistance(c);
    if (distA >= 0 && (distC < 0 || distA < distC)) {
      shapes.push({ kind: 'early-return', at: n.index, path: a, other: c, error: errorBlocks.has(a) });
      continue;
    }
    if (distC >= 0 && (distA < 0 || distC < distA)) {
      shapes.push({ kind: 'early-return', at: n.index, path: c, other: a, error: errorBlocks.has(c) });
      continue;
    }

    // 両方の道が同じ場所に合流するなら if / if-else
    const merge = firstMerge(nodes, a, c, 6);
    if (merge >= 0) {
      shapes.push({
        kind: merge === a || merge === c ? 'if' : 'if-else',
        at: n.index, thenBlock: c, elseBlock: a, merge,
        error: errorBlocks.has(a) || errorBlocks.has(c),
      });
    }
  }
  return shapes;
}

/** 2 つの道が最初に出会うブロック。見つからなければ -1。 */
function firstMerge(nodes, a, b, depth) {
  const seen = new Set();
  let cur = a;
  for (let i = 0; i < depth && cur >= 0 && nodes[cur]; i++) {
    seen.add(cur);
    const next = nodes[cur].succ.filter((s) => s.to >= 0);
    if (!next.length) break;
    cur = next[next.length - 1].to;
  }
  cur = b;
  for (let i = 0; i < depth && cur >= 0 && nodes[cur]; i++) {
    if (seen.has(cur)) return cur;
    const next = nodes[cur].succ.filter((s) => s.to >= 0);
    if (!next.length) break;
    cur = next[next.length - 1].to;
  }
  return -1;
}

/**
 * 画面に並べるための一次元の道順。
 * ブロックごとに「深さ」と「印」を付けて返すので、UI は木のように描くだけでよい。
 *
 * @returns {Array<{index:number, depth:number, marker:string, startRow:number, endRow:number, role:string|null}>}
 */
export function outline(cfg) {
  const out = [];
  const shapeAt = new Map();
  for (const s of cfg.shapes || []) {
    if (s.kind === 'if' || s.kind === 'if-else' || s.kind === 'early-return') shapeAt.set(s.at, s);
  }
  const loopHeaders = new Set((cfg.shapes || []).filter((s) => s.kind === 'loop').map((s) => s.header));
  const loopLatches = new Set((cfg.shapes || []).filter((s) => s.kind === 'loop').map((s) => s.latch));

  let depth = 0;
  for (const n of cfg.nodes) {
    let marker = '';
    if (loopHeaders.has(n.index)) marker = 'loop-start';
    else if (loopLatches.has(n.index)) marker = 'loop-end';
    else if (shapeAt.has(n.index)) marker = shapeAt.get(n.index).kind;
    else if (n.isExit) marker = 'exit';
    else if (n.isJoin) marker = 'join';

    out.push({
      index: n.index, depth, marker,
      startRow: n.startRow, endRow: n.endRow,
      role: n.role,
      succ: n.succ.map((s) => ({ to: s.to, kind: s.kind })),
      isExit: n.isExit,
    });
    if (marker === 'loop-start' || marker === 'if' || marker === 'if-else') depth = Math.min(depth + 1, 3);
    else if (marker === 'loop-end' || marker === 'join') depth = Math.max(depth - 1, 0);
  }
  return out;
}
