/* Behavioural value-shape aggregation for stripped binaries. */
export const SHAPE = { DECREASE: 1, INCREASE: 2, CLAMP: 4, CROSS: 8, SCALED: 16 };
export const AMOUNT = { NONE: 0, FIELD: 1, IMM: 2, CALL: 3 };

const CONTAINER_SPAN = 0x20;
const BIG_OBJECT = 0x80;
const BIG_RATIO = 0.25;
const ROLE_MARGIN = 1.25;

function identityArray(scan, amount = false) {
  if (!scan) return null;
  return amount
    ? (scan.amtBaseIdentity || scan.amtBaseFamily || scan.amountBaseIdentity || null)
    : (scan.baseIdentity || scan.baseFamily || scan.objectIdentity || null);
}
function identityAt(values, index) {
  if (!values || index >= values.length) return null;
  const value = values[index];
  if (value == null || value === '' || value === 0xffffffff || value === 0xffffffffn) return null;
  return typeof value === 'bigint' ? value.toString() : String(value);
}
function keyOf(identity, offset, _site, role = 'target') {
  /*
   * Proven identities are always isolated by object family + displacement.
   * Legacy scans may not carry object identity at all. In that case retaining
   * displacement aggregation preserves useful recall, but every resulting
   * score is explicitly multiplied by provenancePenalty() (0.25) and evidence
   * carries `loc-object-identity-unknown`. This satisfies the fail-safe rule:
   * unknown identity can suggest a value, but cannot look as strong as a
   * provenance-separated observation.
   */
  return identity != null ? `${role}:${identity}:${offset}` : `${role}:unknown:${offset}`;
}
function newEntry(offset, size, identity, key) {
  return {
    key, offset, size, identity, identityKnown: identity != null,
    decreases: 0, increases: 0, clamped: 0, crossObject: 0, scaled: 0,
    amountFrom: new Map(), amountFromCall: 0, amountFromImm: 0, sites: [],
    usedAsAmount: 0, usedAgainst: new Map(), usedScaled: 0, usedCross: 0,
    objectSpan: 0, events: 0, inBigObject: 0,
  };
}

/**
 * Aggregate by object-provenance + displacement when provenance is available.
 * Unknown-provenance scans retain low-confidence displacement aggregation for
 * backward compatibility, never full-strength cross-object evidence.
 * Returned Map carries `complete`/`capped` metadata from the worker scan.
 */
export function foldShapes(scan) {
  const out = new Map();
  Object.defineProperties(out, {
    complete: { value: !scan?.capped, enumerable: false, configurable: true },
    capped: { value: !!scan?.capped, enumerable: false, configurable: true },
  });
  if (!scan || !scan.count) return out;
  const { disp, size, flags, amtKind, amtDisp, addr } = scan;
  const span = scan.span || null;
  const bases = identityArray(scan, false);
  const amountBases = identityArray(scan, true);

  for (let i = 0; i < scan.count; i++) {
    const d = disp[i];
    const identity = identityAt(bases, i);
    const key = keyOf(identity, d, addr[i], 'target');
    let e = out.get(key);
    if (!e) { e = newEntry(d, size[i], identity, key); out.set(key, e); }
    e.events++;
    if (span) {
      if (span[i] > e.objectSpan) e.objectSpan = span[i];
      if (span[i] >= BIG_OBJECT) e.inBigObject++;
    }
    const f = flags[i];
    if (f & SHAPE.DECREASE) e.decreases++;
    if (f & SHAPE.INCREASE) e.increases++;
    if (f & SHAPE.CLAMP) e.clamped++;
    if (f & SHAPE.CROSS) e.crossObject++;
    if (f & SHAPE.SCALED) e.scaled++;
    if (e.sites.length < 8) e.sites.push({ addr: addr[i], flags: f });
    if (amtKind[i] === AMOUNT.FIELD) {
      const a = amtDisp[i];
      const amountIdentity = identityAt(amountBases, i);
      const sourceKey = amountIdentity != null ? `${amountIdentity}:${a}` : `unknown:${a}`;
      e.amountFrom.set(sourceKey, (e.amountFrom.get(sourceKey) || 0) + 1);
    } else if (amtKind[i] === AMOUNT.CALL) e.amountFromCall++;
    else if (amtKind[i] === AMOUNT.IMM) e.amountFromImm++;
  }

  const amtSize = scan.amtSize || null;
  const amtSpan = scan.amtSpan || null;
  for (let i = 0; i < scan.count; i++) {
    if (amtKind[i] !== AMOUNT.FIELD || !(flags[i] & SHAPE.DECREASE)) continue;
    const a = amtDisp[i];
    const identity = identityAt(amountBases, i);
    const key = keyOf(identity, a, addr[i], 'amount');
    let src = out.get(key);
    if (!src) { src = newEntry(a, 0, identity, key); out.set(key, src); }
    if (!src.size && amtSize && amtSize[i]) src.size = amtSize[i];
    const sp = amtSpan ? amtSpan[i] : (span ? span[i] : 0);
    if (sp > src.objectSpan) src.objectSpan = sp;
    src.events++;
    if (sp >= BIG_OBJECT) src.inBigObject++;
    src.usedAsAmount++;
    const targetIdentity = identityAt(bases, i);
    const againstKey = targetIdentity != null ? `${targetIdentity}:${disp[i]}` : `unknown:${disp[i]}`;
    src.usedAgainst.set(againstKey, (src.usedAgainst.get(againstKey) || 0) + 1);
    if (flags[i] & SHAPE.SCALED) src.usedScaled++;
    if (flags[i] & SHAPE.CROSS) src.usedCross++;
  }
  return out;
}

function looksLikeContainerHead(e) {
  if (e.offset >= CONTAINER_SPAN) return false;
  return (e.inBigObject || 0) / (e.events || 1) < BIG_RATIO;
}
function plausibleStatSize(e) { return !e.size || e.size === 4 || e.size === 2; }
function provenancePenalty(e) { return e.identityKnown ? 1 : 0.25; }

function resourceScore(e) {
  if (!e.decreases || looksLikeContainerHead(e) || !plausibleStatSize(e)) return 0;
  let s = Math.min(1, e.decreases / 6) * 0.4;
  if (e.increases) s += Math.min(1, e.increases / 4) * 0.25;
  if (e.clamped) s += Math.min(1, e.clamped / Math.max(1, e.decreases)) * 0.2;
  if (e.crossObject) s += Math.min(1, e.crossObject / 3) * 0.15;
  if ((e.inBigObject || 0) / (e.events || 1) >= 0.5) s = Math.min(1, s + 0.1);
  return Math.min(1, s) * provenancePenalty(e);
}

function damageSourceScore(e, resourceKeys) {
  if (!e.usedAsAmount || looksLikeContainerHead(e) || !plausibleStatSize(e)) return 0;
  let s = Math.min(1, e.usedAsAmount / 4) * 0.45;
  if (e.usedCross) s += Math.min(1, e.usedCross / 3) * 0.25;
  if (e.usedScaled) s += Math.min(1, e.usedScaled / 3) * 0.15;
  let againstResource = 0;
  for (const [key, n] of e.usedAgainst) if (resourceKeys.has(key) || resourceKeys.has(key.split(':').pop())) againstResource += n;
  if (againstResource) s += Math.min(1, againstResource / 3) * 0.25;
  if (e.decreases + e.increases > e.usedAsAmount) s *= 0.3;
  return Math.min(1, s) * provenancePenalty(e);
}

function assignRoles(folded) {
  if (folded.__roles) return folded.__roles;
  const roles = new Map();
  const draft = new Set();
  for (const e of folded.values()) if (resourceScore(e) > 0) { draft.add(e.key); draft.add(String(e.offset)); }
  for (const e of folded.values()) {
    const res = resourceScore(e), dmg = damageSourceScore(e, draft);
    let role = null;
    if (res > 0 || dmg > 0) {
      if (res >= dmg * ROLE_MARGIN) role = 'resource';
      else if (dmg >= res * ROLE_MARGIN) role = 'damage-source';
      else role = 'ambiguous';
    }
    roles.set(e.key, { role, resource: res, damage: dmg });
  }
  try { Object.defineProperty(folded, '__roles', { value: roles, enumerable: false }); } catch { /* frozen */ }
  return roles;
}

function entriesAt(folded, offset) {
  const out = [];
  for (const e of folded?.values?.() || []) if (e.offset === offset) out.push(e);
  return out;
}
function bestAt(folded, offset) {
  return entriesAt(folded, offset).sort((a, b) => (b.events || 0) - (a.events || 0))[0] || null;
}

export function roleOf(folded, offset) {
  if (!folded?.size) return null;
  const entries = entriesAt(folded, offset);
  if (!entries.length) return null;
  const roles = assignRoles(folded);
  const values = entries.map((e) => roles.get(e.key)).filter(Boolean);
  if (!values.length) return null;
  const names = new Set(values.map((r) => r.role));
  if (names.size > 1) return { role: 'ambiguous', resource: Math.max(...values.map((r) => r.resource)), damage: Math.max(...values.map((r) => r.damage)), multipleObjects: true };
  return values.sort((a, b) => Math.max(b.resource, b.damage) - Math.max(a.resource, a.damage))[0];
}

export function resources(folded, limit = 12) {
  const roles = assignRoles(folded), out = [];
  for (const e of folded.values()) {
    const r = roles.get(e.key);
    if (r?.role === 'resource') out.push(Object.assign({}, e, { score: r.resource, role: 'resource', roles: r, complete: folded.complete !== false }));
  }
  out.sort((a, b) => b.score - a.score || (b.decreases + b.increases) - (a.decreases + a.increases));
  return out.slice(0, limit);
}

export function damageSources(folded, res, limit = 12) {
  const resourceKeys = new Set();
  for (const r of res || []) { resourceKeys.add(r.key); resourceKeys.add(String(r.offset)); }
  const roles = assignRoles(folded), out = [];
  for (const e of folded.values()) {
    const r = roles.get(e.key);
    if (r?.role !== 'damage-source') continue;
    const score = damageSourceScore(e, resourceKeys);
    if (score > 0) out.push(Object.assign({}, e, { score, role: 'damage-source', roles: r, complete: folded.complete !== false }));
  }
  out.sort((a, b) => b.score - a.score || b.usedAsAmount - a.usedAsAmount);
  return out.slice(0, limit);
}

export function evidenceFor(folded, offset, goalId) {
  if (!folded?.size) return null;
  const e = bestAt(folded, offset);
  if (!e) return null;
  const codes = [];
  if (folded.capped) codes.push({ code: 'loc-scan-capped', strength: 1, detail: { offset, complete: false } });
  if (!e.identityKnown) codes.push({ code: 'loc-object-identity-unknown', strength: 1, detail: { offset } });
  if (looksLikeContainerHead(e)) {
    codes.push({ code: 'loc-container-head', strength: 1, detail: { offset, events: e.events, objectSpan: e.objectSpan } });
    return { codes, shape: e, complete: folded.complete !== false };
  }
  const res = resources(folded, 24);
  const resourceKeys = new Set();
  for (const r of res) { resourceKeys.add(r.key); resourceKeys.add(String(r.offset)); }
  const role = assignRoles(folded).get(e.key) || { role: null };
  if (role.role === 'ambiguous') codes.push({ code: 'loc-role-conflict', strength: 1, detail: { offset, resource: role.resource, damage: role.damage } });
  if (goalId === 'attack' || goalId === 'damage') {
    const s = role.role === 'damage-source' ? damageSourceScore(e, resourceKeys) : 0;
    if (s > 0) codes.push({ code: 'loc-damage-source', strength: s, detail: { offset, usedAsAmount: e.usedAsAmount, crossObject: e.usedCross, scaled: e.usedScaled, against: Array.from(e.usedAgainst.keys()).slice(0, 3), identityKnown: e.identityKnown } });
  } else if (goalId === 'hp' || goalId === 'stamina') {
    if (role.role === 'resource' && (e.crossObject > 0 || e.amountFromCall > 0)) codes.push({ code: 'loc-resource-drain', strength: resourceScore(e), detail: { offset, decreases: e.decreases, increases: e.increases, clamped: e.clamped, crossObject: e.crossObject, identityKnown: e.identityKnown } });
  } else if (goalId === 'money' || goalId === 'score' || goalId === 'item') {
    if (role.role === 'resource' && e.crossObject === 0) codes.push({ code: 'loc-self-resource', strength: resourceScore(e), detail: { offset, decreases: e.decreases, increases: e.increases, clamped: e.clamped, identityKnown: e.identityKnown } });
  }
  return { codes, shape: e, complete: folded.complete !== false };
}

export function byGoal(folded, goalId, limit = 8) {
  const res = resources(folded, 24);
  switch (goalId) {
    case 'attack': case 'damage': return damageSources(folded, res, limit);
    case 'hp': case 'stamina': return res.filter((e) => e.crossObject > 0 || e.amountFromCall > 0).slice(0, limit);
    case 'money': case 'score': return res.filter((e) => e.crossObject === 0).slice(0, limit);
    case 'level': case 'item': return res.slice(0, limit);
    default: return [];
  }
}
