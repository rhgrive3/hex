/* Pure graph layout / orthogonal edge routing. No DOM dependency. */

export const CHAR_W = 7.9;
export const LINE_H = 18;
export const PAD_X = 12;
export const PAD_Y = 10;
export const MAX_LINES = 14;
export const MAX_CHARS = 46;

const GAP_X = 42;
const GAP_Y = 96;
const GRAPH_PAD = 26;
const PORT_PAD = 14;
const EDGE_STUB = 14;
const CORNER_RADIUS = 7;
const EXTERNAL_PAD = 34;
const EXTERNAL_LANE_GAP = 24;
const LANE_CLEARANCE = 10;

export function layoutNodes(nodes, edges, byId) {
  const succ = new Map();
  const indeg = new Map();
  for (const n of nodes) { succ.set(n.id, []); indeg.set(n.id, 0); }
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.kind === 'back') continue;
    succ.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }

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
        if ((rank.get(s) || 0) > nodes.length) continue;
        rank.set(s, r);
        work.push(s);
      }
    }
  }
  for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

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

  const rows = new Map();
  for (const n of nodes) {
    const r = rank.get(n.id);
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push(n.id);
  }
  const ranksSorted = Array.from(rows.keys()).sort((a, b) => a - b);

  const order = new Map();
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

  for (let pass = 0; pass < 6; pass++) {
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

  const rowWidth = (ids) => ids.reduce((s, id) => s + size.get(id).w, 0) +
    GAP_X * Math.max(0, ids.length - 1);
  let contentWidth = 200;
  for (const r of ranksSorted) contentWidth = Math.max(contentWidth, rowWidth(rows.get(r)));

  const pos = new Map();
  const rowBounds = new Map();
  let y = GRAPH_PAD + 18;
  for (const r of ranksSorted) {
    const ids = rows.get(r);
    let x = GRAPH_PAD + (contentWidth - rowWidth(ids)) / 2;
    let tallest = 0;
    for (const id of ids) {
      const s = size.get(id);
      pos.set(id, { x, y, w: s.w, h: s.h, rank: r });
      x += s.w + GAP_X;
      tallest = Math.max(tallest, s.h);
    }
    rowBounds.set(r, { top: y, bottom: y + tallest });
    y += tallest + GAP_Y;
  }

  return {
    pos, rank, rows, rowBounds, ranksSorted,
    width: contentWidth + GRAPH_PAD * 2,
    height: y - GAP_Y + GRAPH_PAD + 18,
  };
}

export function routeEdges(edges, layout) {
  const valid = [];
  edges.forEach((edge, index) => {
    const a = layout.pos.get(edge.from);
    const b = layout.pos.get(edge.to);
    if (!a || !b) return;
    valid.push({ edge, index, a, b, isBack: edge.kind === 'back' || b.rank <= a.rank });
  });

  const sourcePort = new Map();
  const targetPort = new Map();
  assignVerticalPorts(valid, sourcePort, targetPort);
  const { sourceTrack, targetTrack, sourceJogY, targetJogY } = assignEndpointTracks(valid, sourcePort, targetPort, layout);

  const local = [];
  const external = [];
  for (const item of valid) {
    const rankSpan = item.b.rank - item.a.rank;
    if (!item.isBack && rankSpan === 1) local.push(item);
    else external.push(item);
  }

  const routes = [];
  const corridorGroups = new Map();
  for (const item of local) {
    const key = item.a.rank + '>' + item.b.rank;
    if (!corridorGroups.has(key)) corridorGroups.set(key, []);
    corridorGroups.get(key).push(item);
  }
  for (const group of corridorGroups.values()) {
    group.sort((u, v) => {
      const ux = sourcePort.get(u).x + targetPort.get(u).x;
      const vx = sourcePort.get(v).x + targetPort.get(v).x;
      return ux - vx || u.index - v.index;
    });
    const fromBounds = layout.rowBounds.get(group[0].a.rank);
    const toBounds = layout.rowBounds.get(group[0].b.rank);
    const corridorHeight = toBounds.top - fromBounds.bottom;
    const band = Math.max(EDGE_STUB, corridorHeight * 0.34);
    const low = fromBounds.bottom + band;
    const high = toBounds.top - band;
    group.forEach((item, i) => {
      const laneY = distributeBetween(low, high, i, group.length);
      const sx = sourcePort.get(item).x;
      const tx = targetPort.get(item).x;
      const stx = sourceTrack.get(item);
      const ttx = targetTrack.get(item);
      const sourceY = item.a.y + item.a.h;
      const targetY = item.b.y - 2;
      const points = endpointTrackedPoints(sx, stx, sourceY, sourceJogY.get(item), laneY, ttx, tx, targetJogY.get(item), targetY);
      routes.push({
        edge: item.edge, index: item.index, points,
        label: item.edge.label ? { x: (sx + tx) / 2, y: laneY - 3 } : null,
      });
    });
  }

  const bounds = graphNodeBounds(layout.pos);
  const graphCenter = (bounds.left + bounds.right) / 2;
  const laneSegments = { left: [], right: [] };
  const sideLoad = { left: 0, right: 0 };

  external.sort((u, v) => {
    const us = Math.abs(u.b.rank - u.a.rank);
    const vs = Math.abs(v.b.rank - v.a.rank);
    return vs - us || u.index - v.index;
  });

  for (const item of external) {
    const sx = sourcePort.get(item).x;
    const tx = targetPort.get(item).x;
    const stx = sourceTrack.get(item);
    const ttx = targetTrack.get(item);
    const exitY = sourceJogY.get(item);
    const enterY = targetJogY.get(item);
    const top = Math.min(exitY, enterY);
    const bottom = Math.max(exitY, enterY);

    const avgX = (sx + tx) / 2;
    let side;
    if (avgX < graphCenter - 24) side = 'left';
    else if (avgX > graphCenter + 24) side = 'right';
    else side = sideLoad.left <= sideLoad.right ? 'left' : 'right';

    const lane = allocateLane(laneSegments[side], top, bottom);
    laneSegments[side][lane].push({ top, bottom });
    sideLoad[side] += 1;

    const laneX = side === 'left'
      ? bounds.left - EXTERNAL_PAD - lane * EXTERNAL_LANE_GAP
      : bounds.right + EXTERNAL_PAD + lane * EXTERNAL_LANE_GAP;

    const sourceY = item.a.y + item.a.h;
    const targetY = item.b.y - 2;
    const points = simplifyPoints([
      { x: sx, y: sourceY },
      { x: sx, y: exitY },
      { x: stx, y: exitY },
      { x: laneX, y: exitY },
      { x: laneX, y: enterY },
      { x: ttx, y: enterY },
      { x: tx, y: enterY },
      { x: tx, y: targetY },
    ]);

    const labelY = (top + bottom) / 2;
    routes.push({
      edge: item.edge, index: item.index, points,
      label: item.edge.label ? { x: laneX, y: labelY } : null,
      external: true, side, lane,
    });
  }

  routes.sort((a, b) => a.index - b.index);
  fitRoutesIntoLayout(layout, routes);
  return routes;
}

function assignEndpointTracks(items, sourcePort, targetPort, layout) {
  const sourceTrack = new Map();
  const targetTrack = new Map();
  const sourceJogY = new Map();
  const targetJogY = new Map();
  const corridors = new Map();
  const add = (key, item, endpoint, baseX) => {
    if (!corridors.has(key)) corridors.set(key, []);
    corridors.get(key).push({ item, endpoint, baseX });
  };

  for (const item of items) {
    add('gap:' + item.a.rank, item, 'source', sourcePort.get(item).x);
    const targetKey = item.b.rank > 0 ? 'gap:' + (item.b.rank - 1) : 'top';
    add(targetKey, item, 'target', targetPort.get(item).x);
  }

  for (const [key, records] of corridors) {
    records.sort((a, b) => a.baseX - b.baseX || a.item.index - b.item.index || (a.endpoint < b.endpoint ? -1 : 1));
    const used = [];
    for (const record of records) {
      const x = nearestFreeTrack(record.baseX, used);
      used.push(x);
      (record.endpoint === 'source' ? sourceTrack : targetTrack).set(record.item, x);
    }

    const bounds = corridorBounds(key, layout);
    const height = Math.max(24, bounds.bottom - bounds.top);
    const sourceRecords = records.filter((r) => r.endpoint === 'source')
      .sort((a, b) => a.baseX - b.baseX || a.item.index - b.item.index);
    const targetRecords = records.filter((r) => r.endpoint === 'target')
      .sort((a, b) => a.baseX - b.baseX || a.item.index - b.item.index);
    const sourceLow = bounds.top + 4;
    const sourceHigh = bounds.top + Math.max(8, height * 0.28);
    const targetLow = bounds.bottom - Math.max(8, height * 0.28);
    const targetHigh = bounds.bottom - 4;
    sourceRecords.forEach((record, i) => {
      sourceJogY.set(record.item, distributeBetween(sourceLow, sourceHigh, i, sourceRecords.length));
    });
    targetRecords.forEach((record, i) => {
      targetJogY.set(record.item, distributeBetween(targetLow, targetHigh, i, targetRecords.length));
    });
  }
  return { sourceTrack, targetTrack, sourceJogY, targetJogY };
}

function corridorBounds(key, layout) {
  if (key === 'top') {
    const first = layout.rowBounds.get(layout.ranksSorted[0]);
    return { top: Math.max(2, first.top - 42), bottom: first.top - 2 };
  }
  const rank = Number(key.slice(4));
  const from = layout.rowBounds.get(rank);
  const nextRank = layout.ranksSorted.find((r) => r > rank);
  if (from && nextRank != null) {
    const to = layout.rowBounds.get(nextRank);
    return { top: from.bottom, bottom: to.top - 2 };
  }
  const top = from ? from.bottom : layout.height - 44;
  return { top, bottom: Math.min(layout.height - 2, top + 42) };
}

function nearestFreeTrack(baseX, used) {
  const spacing = 6;
  const clearance = 3;
  for (let ring = 0; ring <= 8; ring++) {
    const offsets = ring === 0 ? [0] : [ring * spacing, -ring * spacing];
    for (const offset of offsets) {
      const candidate = baseX + offset;
      if (used.every((x) => Math.abs(x - candidate) >= clearance)) return candidate;
    }
  }
  return baseX + (used.length + 1) * spacing;
}

function endpointTrackedPoints(sx, stx, sourceY, sourceJogY, laneY, ttx, tx, targetJogY, targetY) {
  return simplifyPoints([
    { x: sx, y: sourceY },
    { x: sx, y: sourceJogY },
    { x: stx, y: sourceJogY },
    { x: stx, y: laneY },
    { x: ttx, y: laneY },
    { x: ttx, y: targetJogY },
    { x: tx, y: targetJogY },
    { x: tx, y: targetY },
  ]);
}

function assignVerticalPorts(items, sourcePort, targetPort) {
  const outgoing = new Map();
  const incoming = new Map();
  const push = (map, id, item) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(item);
  };
  for (const item of items) {
    push(outgoing, item.edge.from, item);
    push(incoming, item.edge.to, item);
  }

  for (const [id, list] of outgoing) {
    const node = list[0].a;
    list.sort((u, v) => centerX(u.b) - centerX(v.b) || u.index - v.index);
    list.forEach((item, i) => sourcePort.set(item, {
      x: distributedPortX(node, i, list.length), y: node.y + node.h,
    }));
  }
  for (const [id, list] of incoming) {
    const node = list[0].b;
    list.sort((u, v) => centerX(u.a) - centerX(v.a) || u.index - v.index);
    list.forEach((item, i) => targetPort.set(item, {
      x: distributedPortX(node, i, list.length), y: node.y,
    }));
  }
}

function distributedPortX(node, index, count) {
  if (count <= 1) return centerX(node);
  const left = node.x + Math.min(PORT_PAD, node.w * 0.25);
  const right = node.x + node.w - Math.min(PORT_PAD, node.w * 0.25);
  return left + ((index + 1) / (count + 1)) * (right - left);
}

function distributeBetween(low, high, index, count) {
  if (high <= low) return (low + high) / 2;
  return low + ((index + 1) / (count + 1)) * (high - low);
}

function allocateLane(lanes, top, bottom) {
  for (let i = 0; i < lanes.length; i++) {
    const blocked = lanes[i].some((s) => !(bottom + LANE_CLEARANCE < s.top || top - LANE_CLEARANCE > s.bottom));
    if (!blocked) return i;
  }
  lanes.push([]);
  return lanes.length - 1;
}

function graphNodeBounds(pos) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const p of pos.values()) {
    left = Math.min(left, p.x);
    right = Math.max(right, p.x + p.w);
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y + p.h);
  }
  if (!Number.isFinite(left)) return { left: GRAPH_PAD, right: 200, top: GRAPH_PAD, bottom: 200 };
  return { left, right, top, bottom };
}

function fitRoutesIntoLayout(layout, routes) {
  const nodeBounds = graphNodeBounds(layout.pos);
  let minX = nodeBounds.left;
  let maxX = nodeBounds.right;
  for (const r of routes) {
    for (const p of r.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
    if (r.label) { minX = Math.min(minX, r.label.x - 50); maxX = Math.max(maxX, r.label.x + 50); }
  }

  const shift = minX < GRAPH_PAD ? GRAPH_PAD - minX : 0;
  if (shift) {
    for (const p of layout.pos.values()) p.x += shift;
    for (const r of routes) {
      for (const p of r.points) p.x += shift;
      if (r.label) r.label.x += shift;
    }
    maxX += shift;
  }
  layout.width = Math.max(layout.width + shift, maxX + GRAPH_PAD);
}

function simplifyPoints(points) {
  const dedup = [];
  for (const p of points) {
    const prev = dedup[dedup.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) dedup.push(p);
  }
  if (dedup.length < 3) return dedup;
  const out = [dedup[0]];
  for (let i = 1; i < dedup.length - 1; i++) {
    const a = out[out.length - 1], b = dedup[i], c = dedup[i + 1];
    const vertical = a.x === b.x && b.x === c.x;
    const horizontal = a.y === b.y && b.y === c.y;
    if (!vertical && !horizontal) out.push(b);
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

export function roundedOrthogonalPath(points) {
  if (!points || !points.length) return '';
  if (points.length === 1) return 'M ' + points[0].x + ' ' + points[0].y;
  let d = 'M ' + points[0].x + ' ' + points[0].y;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], cur = points[i], next = points[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(CORNER_RADIUS, inLen / 2, outLen / 2);
    if (!r || (prev.x !== cur.x && prev.y !== cur.y) || (cur.x !== next.x && cur.y !== next.y)) {
      d += ' L ' + cur.x + ' ' + cur.y;
      continue;
    }
    const before = pointToward(cur, prev, r);
    const after = pointToward(cur, next, r);
    d += ' L ' + before.x + ' ' + before.y + ' Q ' + cur.x + ' ' + cur.y + ' ' + after.x + ' ' + after.y;
  }
  const end = points[points.length - 1];
  return d + ' L ' + end.x + ' ' + end.y;
}

function pointToward(from, to, distance) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: from.x + dx / len * distance, y: from.y + dy / len * distance };
}

function centerX(p) { return p.x + p.w / 2; }

export function graphRoutingDiagnostics(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layout = layoutNodes(nodes, edges, byId);
  const routes = routeEdges(edges, layout);
  return {
    width: layout.width,
    height: layout.height,
    nodes: new Map(Array.from(layout.pos, ([id, p]) => [id, { ...p }])),
    routes: routes.map((r) => ({
      edge: { ...r.edge },
      points: r.points.map((p) => ({ ...p })),
      label: r.label ? { ...r.label } : null,
      external: !!r.external,
      side: r.side || null,
      lane: r.lane == null ? null : r.lane,
    })),
  };
}
