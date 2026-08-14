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

function collinearOverlap(a, b) {
  const aHorizontal = Math.abs(a.a.y - a.b.y) < 1e-6;
  const bHorizontal = Math.abs(b.a.y - b.b.y) < 1e-6;
  if (aHorizontal !== bHorizontal) return 0;

  if (aHorizontal) {
    if (Math.abs(a.a.y - b.a.y) > 1e-6) return 0;
    const low = Math.max(Math.min(a.a.x, a.b.x), Math.min(b.a.x, b.b.x));
    const high = Math.min(Math.max(a.a.x, a.b.x), Math.max(b.a.x, b.b.x));
    return high - low;
  }

  if (Math.abs(a.a.x - b.a.x) > 1e-6) return 0;
  const low = Math.max(Math.min(a.a.y, a.b.y), Math.min(b.a.y, b.b.y));
  const high = Math.min(Math.max(a.a.y, a.b.y), Math.max(b.a.y, b.b.y));
  return high - low;
}

function assertRoutingGeometry(routed, name) {
  const segments = [];
  routed.routes.forEach((route, routeIndex) => {
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1];
      const b = route.points[i];
      assert.ok(
        Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6,
        `${name}: all routing segments must remain orthogonal`,
      );
      segments.push({ routeIndex, a, b });

      for (const [id, rect] of routed.nodes) {
        if (id === route.edge.from || id === route.edge.to) continue;
        assert.equal(
          crossesRectInterior(a, b, rect),
          false,
          `${name}: edge ${route.edge.from}->${route.edge.to} crosses node ${id}`,
        );
      }
    }
  });

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (segments[i].routeIndex === segments[j].routeIndex) continue;
      assert.ok(
        collinearOverlap(segments[i], segments[j]) <= 0.5,
        `${name}: separate edges must not share a visible line segment`,
      );
    }
  }
}

assertRoutingGeometry(graph, 'basic');

/* Regression: dense fan-out + long forward + multiple back edges used to share tracks. */
const denseNodes = Array.from({ length: 9 }, (_, id) => ({ id, title: `B${id}`, lines: [`op_${id}`] }));
const denseEdges = [
  { from: 0, to: 1, kind: 'true' }, { from: 0, to: 2, kind: 'false' }, { from: 0, to: 3, kind: 'jump' },
  { from: 1, to: 4, kind: 'jump' }, { from: 2, to: 4, kind: 'jump' }, { from: 3, to: 5, kind: 'jump' },
  { from: 4, to: 6, kind: 'jump' }, { from: 5, to: 6, kind: 'jump' }, { from: 0, to: 6, kind: 'jump' },
  { from: 1, to: 7, kind: 'jump' }, { from: 2, to: 7, kind: 'jump' }, { from: 6, to: 8, kind: 'jump' },
  { from: 7, to: 8, kind: 'jump' }, { from: 8, to: 1, kind: 'back' }, { from: 7, to: 2, kind: 'back' },
];
assertRoutingGeometry(graphRoutingDiagnostics(denseNodes, denseEdges), 'dense corridors');

/* Regression: many edges leaving one block used to overlap on the first horizontal jog. */
const fanNodes = [
  8, 7, 10, 15, 11, 19, 13, 9, 31, 7,
].map((length, id) => ({ id, title: `B${id}`, lines: ['x'.repeat(length)] }));
const fanEdges = [
  { from: 0, to: 1, kind: 'jump' }, { from: 0, to: 4, kind: 'jump' }, { from: 0, to: 8, kind: 'true' },
  { from: 1, to: 2, kind: 'jump' }, { from: 1, to: 3, kind: 'true' }, { from: 1, to: 5, kind: 'true' },
  { from: 1, to: 6, kind: 'true' }, { from: 1, to: 7, kind: 'true' }, { from: 1, to: 9, kind: 'true' },
  { from: 2, to: 3, kind: 'jump' }, { from: 2, to: 8, kind: 'true' }, { from: 3, to: 4, kind: 'jump' },
  { from: 3, to: 7, kind: 'jump' }, { from: 4, to: 5, kind: 'jump' }, { from: 5, to: 6, kind: 'jump' },
  { from: 5, to: 7, kind: 'true' }, { from: 6, to: 7, kind: 'jump' }, { from: 6, to: 8, kind: 'true' },
  { from: 6, to: 9, kind: 'jump' }, { from: 7, to: 8, kind: 'jump' }, { from: 8, to: 9, kind: 'jump' },
  { from: 6, to: 3, kind: 'back' }, { from: 9, to: 2, kind: 'back' },
];
assertRoutingGeometry(graphRoutingDiagnostics(fanNodes, fanEdges), 'fan-out jogs');

console.log('graph-routing: ok');
