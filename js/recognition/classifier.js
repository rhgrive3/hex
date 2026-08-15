import { fingerprintFunction } from '../fingerprint/index.js';
export const FUNCTION_CLASSES = Object.freeze(['APPLICATION','SYSTEM','RUNTIME','SDK','LIBRARY','GENERATED','UNKNOWN']);

const RUNTIME_IMPORTS = [/^_?objc_/, /^_?swift_/, /^_?dyld_/, /^_?__?cxa_/, /^_?pthread_/, /^_?malloc$/, /^_?free$/];
const SYSTEM_LIBS = [/libsystem/i, /foundation/i, /corefoundation/i, /libobjc/i, /libswift/i];
const GENERATED = [/\bthunk\b/i, /^outlined(?: function)?\b/i, /block_invoke/i, /partial apply/i, /witness thunk/i, /metadata accessor/i];
const RUNTIME_NAMES = [/^_?(?:objc_|swift_|dyld_|__?cxa_|pthread_)/i];

export function classifyFunction(input = {}, context = {}) {
  const fp = fingerprintFunction(input);
  const evidence = [];
  const signature = context.signature?.classification && FUNCTION_CLASSES.includes(context.signature.classification) ? context.signature : null;
  const signatureConfidence = Number(signature?.confidence ?? 0);
  const signatureExact = signature?.exact === true || ['exact','normalized-identical'].includes(signature?.identity);
  if (signature && signatureExact && signatureConfidence >= 0.9) {
    return { classification:signature.classification, confidence:signatureConfidence, evidence:['signature:'+ (signature.library||signature.name||'known')], hardSuppress:true };
  }
  const name = fp.name || '';
  if (signature) evidence.push('signature-hint:' + (signature.library || signature.name || signature.classification));
  if (context.owningLibrary && SYSTEM_LIBS.some((rx) => rx.test(String(context.owningLibrary)))) return { classification:'SYSTEM', confidence:0.92, evidence:['system-library:' + context.owningLibrary], hardSuppress:true };
  if (GENERATED.some((rx) => rx.test(name))) return { classification: 'GENERATED', confidence: 0.9, evidence: ['compiler-generated-name'], hardSuppress:true };
  if (RUNTIME_NAMES.some((rx) => rx.test(name))) return { classification:'RUNTIME', confidence:0.88, evidence:['runtime-symbol-name'], hardSuppress:true };
  const runtimeImports = fp.imports.filter((x) => RUNTIME_IMPORTS.some((rx) => rx.test(String(x))));
  if (context.vendor?.confidence >= 0.8) {
    const classification = FUNCTION_CLASSES.includes(context.vendor.classification) ? context.vendor.classification : context.vendor.kind === 'runtime' ? 'RUNTIME' : context.vendor.kind === 'library' ? 'LIBRARY' : 'SDK';
    return { classification, confidence: context.vendor.confidence, evidence: context.vendor.evidence || [], hardSuppress:true };
  }
  let appScore = 0;
  if (fp.objc.class && !context.vendor) { appScore += 0.22; evidence.push('custom-objc-type'); }
  if (fp.swift.typeDescriptor && !context.vendor) { appScore += 0.22; evidence.push('custom-swift-type'); }
  if (fp.strings.some((s) => context.appStrings?.has?.(s))) { appScore += 0.18; evidence.push('app-specific-string'); }
  if (fp.semantic.writes.length) { appScore += 0.16; evidence.push('state-writes'); }
  if (context.calledFromApplication) { appScore += 0.16; evidence.push('application-entry-path'); }
  if (context.notKnownVendor) { appScore += 0.14; evidence.push('not-known-vendor'); }
  if (runtimeImports.length) evidence.push('uses-runtime-api');
  if (appScore >= 0.38) return { classification: 'APPLICATION', confidence: Math.min(0.95, 0.5 + appScore / 2), evidence, hardSuppress:false };
  if (signature) return { classification:signature.classification, confidence:Math.min(0.79, Math.max(0.35, signatureConfidence)), evidence, hardSuppress:false };
  return { classification: 'UNKNOWN', confidence: 0.35, evidence, hardSuppress:false };
}

export function applicationCodeScore(input = {}, context = {}) {
  const fp = fingerprintFunction(input); const cls = classifyFunction(fp, context);
  let score = cls.classification === 'APPLICATION' ? 0.45 : cls.classification === 'UNKNOWN' ? 0.2 : 0;
  if (context.notKnownVendor) score += 0.12;
  if (fp.objc.class || fp.swift.typeDescriptor) score += 0.1;
  if (fp.semantic.writes.length || fp.fieldAccessShape.length) score += 0.12;
  if (fp.strings.some((s) => context.appStrings?.has?.(s))) score += 0.1;
  if (context.calledFromApplication) score += 0.08;
  if (cls.classification === 'SDK' || cls.classification === 'RUNTIME' || cls.classification === 'SYSTEM') {
    score -= cls.hardSuppress === true && cls.confidence >= 0.8 ? 0.55 : 0.08 * Math.max(0,Math.min(1,cls.confidence || 0));
  }
  return Math.max(0, Math.min(1, score));
}

const SUBSYSTEM_RULES = {
  UI: { strings: [/button|view|screen|menu|dialog|label/i], calls: [/ui(view|button|label)|presentview|layout/i] },
  network: { strings: [/https?:|api\.|socket|request|response/i], calls: [/urlsession|http|socket|connect|send|recv/i] },
  persistence: { strings: [/database|sqlite|save|load|preferences|keychain/i], calls: [/sqlite|write|read|serialize|deserialize|userdefaults|keychain/i] },
  gameplay: { strings: [/player|enemy|battle|stage|damage|attack/i], calls: [/update|tick|physics|collision/i] },
  'economy/reward': { strings: [/coin|gem|reward|currency|purchase|gacha|xp|experience/i], calls: [/purchase|reward|inventory|wallet/i] },
  'security/integrity': { strings: [/integrity|jailbreak|tamper|signature|checksum|receipt/i], calls: [/seccode|crypto|hash|verify|attest/i] },
  ads: { strings: [/rewarded.?ad|interstitial|admob|applovin|ironsource|unityads/i], calls: [/loadad|showad|adrequest/i] },
  analytics: { strings: [/analytics|event|telemetry|firebase|appsflyer|adjust/i], calls: [/logevent|track|telemetry/i] },
};
export function discoverSubsystems(input = {}) {
  const fp = fingerprintFunction(input), hayStrings = fp.strings, hayCalls = [...fp.calls, ...fp.imports];
  const out = [];
  for (const [name, rule] of Object.entries(SUBSYSTEM_RULES)) {
    const stringHits = hayStrings.filter((s) => rule.strings.some((rx) => rx.test(s)));
    const callHits = hayCalls.filter((s) => rule.calls.some((rx) => rx.test(s)));
    const semanticHit = name === 'economy/reward' && fp.semantic.writes.length && fp.semantic.thresholds.length;
    const independent = Number(stringHits.length > 0) + Number(callHits.length > 0) + Number(semanticHit);
    if (!independent) continue;
    const confidence = independent >= 2 ? Math.min(0.92, 0.6 + 0.12 * independent) : 0.48;
    out.push({ subsystem: name, confidence, inferred: true, evidence: [...stringHits.slice(0,3), ...callHits.slice(0,3), ...(semanticHit ? ['semantic-write-threshold'] : [])] });
  }
  return out.sort((a,b) => b.confidence - a.confidence);
}

export function clusterFunctions(functions = []) {
  const groups = new Map();
  for (const raw of functions) {
    const fp = fingerprintFunction(raw);
    const cls = classifyFunction(fp, raw.context || {});
    const subs = discoverSubsystems(fp);
    const suppressed = ['SYSTEM','RUNTIME','SDK','LIBRARY','GENERATED'].includes(cls.classification) && cls.hardSuppress === true && cls.confidence >= 0.8;
    const key = suppressed ? `class:${cls.classification}` : subs[0]?.confidence >= 0.6 ? `sub:${subs[0].subsystem}` : fp.cfgHash ? `cfg:${fp.cfgHash}` : cls.classification === 'APPLICATION' ? 'class:APPLICATION' : `unknown:size:${Math.floor(Math.log2(Math.max(1,fp.size)))}`;
    let group = groups.get(key); if (!group) groups.set(key, group = { key, classification: cls.classification, subsystem: subs[0]?.subsystem || null, functions: [] });
    group.functions.push(fp);
  }
  return [...groups.values()].sort((a,b) => b.functions.length - a.functions.length);
}

export function rankApplicationFunctions(functions = [], contextFor = () => ({})) {
  return functions.map((fn, index) => ({ function: fingerprintFunction(fn), index, score: applicationCodeScore(fn, contextFor(fn, index)), classification: classifyFunction(fn, contextFor(fn, index)) })).sort((a,b) => b.score - a.score);
}

export function classificationMetrics(results = []) {
  const total = results.length || 1;
  const counts = Object.fromEntries(FUNCTION_CLASSES.map((x) => [x, 0]));
  for (const item of results) { const c = item.classification?.classification || item.classification || 'UNKNOWN'; if (c in counts) counts[c]++; }
  const suppressed = counts.SYSTEM + counts.RUNTIME + counts.SDK + counts.LIBRARY + counts.GENERATED;
  return { total: results.length, counts, librarySuppressionRate: suppressed / total, applicationCodeReduction: suppressed / total, applicationVisibleRate: counts.APPLICATION / total };
}
