import assert from 'node:assert/strict';
import { graphRoutingDiagnostics } from '../js/graph-routing.js';

const nodes = Array.from({ length: 7 }, (_, id) => ({
  id,
  title: `B${id}`,
  lines: [`op_${id}`],
}));

const edges = [
  { from: 0, to: 1, kind: 'true', label: 'T' },
  { from: 0, to: 2, kind: 'false', label: 'F' },
  { from: 1, to: 3, kind: 'jump' },
  { from: 2, to: 3, kind: 'jump' },
  { from: 3, to: 4, kind: 'jump' },
  { from: 0, to: 4, kind: 'jump' },
  { from: 1, to: 5, kind: 'jump' },
  { from: 4, to: 6, kind: 'jump' },
  { from: 5, to: 6, kind: 'jump' },
  { from: 6, to: 1, kind: 'back', label: 'loop' },
];

const graph = graphRoutingDiagnostics(nodes, edges);
assert.equal(graph.routes.length, edges.length);
assert.ok(graph.width > 0 && graph.height > 0);

const routesFrom0 = graph.routes.filter((route) => route.edge.from === 0);
assert.equal(
  new Set(routesFrom0.map((route) => route.points[0].x.toFixed(3))).size,
  routesFrom0.length,
  'fan-out edges must use distinct source ports',
);

const routesInto6 = graph.routes.filter((route) => route.edge.to === 6);
assert.equal(
  new Set(routesInto6.map((route) => route.points.at(-1).x.toFixed(3))).size,
  routesInto6.length,
  'fan-in edges must use distinct target ports',
);

const longForward = graph.routes.find((route) => route.edge.from === 0 && route.edge.to === 4);
assert.equal(longForward?.external, true, 'long forward edge must use an external lane');

const backEdge = graph.routes.find((route) => route.edge.kind === 'back');
assert.equal(backEdge?.external, true, 'back edge must use an external lane');

function crossesRectInterior(a, b, rect) {
  const epsilon = 0.5;
  const left = rect.x + epsilon;
  const right = rect.x + rect.w - epsilon;
  const top = rect.y + epsilon;
  const bottom = rect.y + rect.h - epsilon;

  if (Math.abs(a.x - b.x) < 1e-6) {
    if (!(a.x > left && a.x < right)) return false;
    const low = Math.min(a.y, b.y);
    const high = Math.max(a.y, b.y);
    return high > top && low < bottom;
  }
  if (Math.abs(a.y - b.y) < 1e-6) {
    if (!(a.y > top && a.y < bottom)) return false;
    const low = Math.min(a.x, b.x);
    const high = Math.max(a.x, b.x);
    return high > left && low < right;
  }
  throw new Error(`non-orthogonal segment: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

for (const route of graph.routes) {
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1];
    const b = route.points[i];
    assert.ok(
      Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6,
      'all routing segments must remain orthogonal',
    );

    for (const [id, rect] of graph.nodes) {
      if (id === route.edge.from || id === route.edge.to) continue;
      assert.equal(
        crossesRectInterior(a, b, rect),
        false,
        `edge ${route.edge.from}->${route.edge.to} crosses node ${id}`,
      );
    }
  }
}

console.log('graph-routing: ok');
