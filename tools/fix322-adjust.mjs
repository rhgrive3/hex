import fs from 'node:fs';

// Expose the ABI lookup as a deterministic pure helper for regression tests.
{
  const p = 'js/dataflow-semantic.js'; let s = fs.readFileSync(p, 'utf8');
  const anchor = `function propertyHelperUpdates(model, ir) {`;
  const helper = `export function objcPropertyHelperAbi(name) {
  const hit = OBJC_PROPERTY_HELPERS.find((h) => h.re.test(String(name || '')));
  return hit ? { kind: hit.kind, offsetReg: hit.offsetReg, valueReg: hit.valueReg } : null;
}

function propertyHelperUpdates(model, ir) {`;
  if (!s.includes(anchor)) throw new Error('property helper export anchor missing');
  s = s.replace(anchor, helper);
  fs.writeFileSync(p, s);
}

// Export feature grouping for direct top-K regression without UI plumbing.
{
  const p = 'js/features.js'; let s = fs.readFileSync(p, 'utf8');
  s = s.replace(`function groupByFeature(hits, opts = {}) {`, `export function groupByFeature(hits, opts = {}) {`);
  fs.writeFileSync(p, s);
}
