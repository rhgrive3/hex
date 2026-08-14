import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8'); const write=(p,s)=>fs.writeFileSync(p,s);
function rep(p,a,b){const s=read(p);if(!s.includes(a))throw new Error(`anchor missing ${p}: ${a.slice(0,120)}`);write(p,s.replace(a,b));}

// #334 — evaluate every symbol-name hit; cap retained seed candidates, not discovery order.
{
  const p='js/rank.js'; let s=read(p);
  const old=`    let scanned = 0;
    for (let i = 0; i < symbols.addrs.length; i++) {
      const a = symbols.addrs[i];
      if (lo != null && (a < lo || a >= hi)) continue;
      const name = symbols.names[i];
      if (!name || !matcher.test(name)) continue;
      const m = matchName(goal, name);
      if (!m) continue;
      const start = symbols.functionCount ? (symbols.isFunctionStart(a) ? a : null) : a;
      const c = candidate(start != null ? start : a, a);
      if (!c) continue;
      c.name = c.name || name;
      addReason(c, REASON.NAME, POINTS[REASON.NAME] * m.score, { name, term: m.term });
      if (++scanned >= 400) { notes.push('name-matches-capped'); break; }
    }`;
  const neu=`    const nameHits = [];
    for (let i = 0; i < symbols.addrs.length; i++) {
      const a = symbols.addrs[i];
      if (lo != null && (a < lo || a >= hi)) continue;
      const name = symbols.names[i];
      if (!name || !matcher.test(name)) continue;
      const m = matchName(goal, name);
      if (!m) continue;
      nameHits.push({ a, name, m });
    }
    nameHits.sort((a,b)=>b.m.score-a.m.score || (a.a < b.a ? -1 : a.a > b.a ? 1 : 0));
    const retained = nameHits.slice(0, Math.max(400, limit * 16));
    if (nameHits.length > retained.length) notes.push('name-matches-retained-topk');
    for (const { a, name, m } of retained) {
      const start = symbols.functionCount ? (symbols.isFunctionStart(a) ? a : null) : a;
      const c = candidate(start != null ? start : a, a);
      if (!c) continue;
      c.name = c.name || name;
      addReason(c, REASON.NAME, POINTS[REASON.NAME] * m.score, { name, term: m.term });
    }`;
  if(!s.includes(old)) throw new Error('rank name cap anchor missing'); s=s.replace(old,neu); write(p,s);
}

// #335 — canonical address<->instruction-row mapping, including variable-length instruction tables.
{
  const p='js/architecture/index.js'; let s=read(p);
  const anchor=`export function architectureCapability(image, engine = {}) {`;
  const helper=`export function instructionRowForAddress({ address, region, adapter, instructions } = {}) {
  if (address == null || !region) return null;
  const a = typeof address === 'bigint' ? address : BigInt(address);
  if (a < region.vmAddr || a >= region.vmAddr + region.size) return null;
  const fixed = adapter?.fixedInstructionSize;
  if (fixed) {
    const rel = a - region.vmAddr, size = BigInt(fixed);
    if (rel % size !== 0n) return null;
    return Number(rel / size);
  }
  const rows = instructions || [];
  let lo=0, hi=rows.length-1;
  while(lo<=hi){const mid=(lo+hi)>>1;const x=rows[mid]?.address;if(x==null)return null;if(x===a)return rows[mid].row ?? mid;if(x<a)lo=mid+1;else hi=mid-1;}
  return null;
}
export function instructionAddressForRow({ row, region, adapter, instructions } = {}) {
  if (!region || !Number.isInteger(row) || row < 0) return null;
  const fixed = adapter?.fixedInstructionSize;
  if (fixed) { const a=region.vmAddr+BigInt(row)*BigInt(fixed); return a < region.vmAddr+region.size ? a : null; }
  const hit=(instructions||[]).find((x,i)=>(x.row ?? i)===row); return hit?.address ?? null;
}

`;
  if(!s.includes(anchor)) throw new Error('architecture helper anchor'); s=s.replace(anchor,helper+anchor); write(p,s);
}
{
  const p='js/ai/interaction/actions.js'; let s=read(p);
  s=s.replace(`import { showXrefs, showValueFlow } from '../../panels.js';`, `import { showXrefs, showValueFlow } from '../../panels.js';\nimport { architectureAdapter, instructionRowForAddress } from '../../architecture/index.js';`);
  s=s.replace(`      const row = Number((addr - region.vmAddr) / 4n);
      app.viewer.select(row, false);
      app.store.set({ selectedRow: row });`, `      const row = instructionRowForAddress({ address: addr, region, adapter: architectureAdapter(app.image?.arch), instructions: app.semantic?.model?.instructions });
      if (row != null) { app.viewer.select(row, false); app.store.set({ selectedRow: row }); }`);
  s=s.replace(`        const row = model && region ? Number((addr - region.vmAddr) / 4n) : null;`, `        const row = model && region ? instructionRowForAddress({ address: addr, region, adapter: architectureAdapter(app.image?.arch), instructions: model.instructions }) : null;`);
  write(p,s);
}
{
  const p='js/tools.js'; let s=read(p);
  const importAnchor=`import { EXAMPLE_PLUGIN } from './plugins.js';`;
  if(s.includes(importAnchor)) s=s.replace(importAnchor, importAnchor+`\nimport { architectureAdapter, instructionRowForAddress, instructionAddressForRow } from './architecture/index.js';`);
  else if(!s.includes('instructionRowForAddress')) { const a=s.indexOf('\n',s.lastIndexOf('import ')); s=s.slice(0,a+1)+`import { architectureAdapter, instructionRowForAddress, instructionAddressForRow } from './architecture/index.js';\n`+s.slice(a+1); }
  s=s.replace(`    const addr = region.vmAddr + BigInt(row) * 4n;`, `    const addr = instructionAddressForRow({ row, region, adapter: architectureAdapter(app.image?.arch), instructions: app.semantic?.model?.instructions });\n    if (addr == null) return null;`);
  s=s.replace(`      return Number(rel / 4n);`, `      return instructionRowForAddress({ address: a, region, adapter: architectureAdapter(app.image?.arch), instructions: app.semantic?.model?.instructions });`);
  s=s.replace(`    addrOfRow: (row) => (region ? region.vmAddr + BigInt(row) * 4n : null),`, `    addrOfRow: (row) => instructionAddressForRow({ row, region, adapter: architectureAdapter(app.image?.arch), instructions: app.semantic?.model?.instructions }),`);
  write(p,s);
}

// #336/#337 — confidence is never verification; unresolved evidence stays unresolved.
{
  const p='js/ai/render/normalize.js'; let s=read(p);
  s=s.replace(`  if (explicit) return explicit;
  if (confidence != null && confidence >= 0.95) return STATUS.VERIFIED;
  if (confidence != null && confidence >= 0.60) return STATUS.SUPPORTED;`, `  if (explicit) return explicit;
  if (confidence != null && confidence >= 0.60) return STATUS.SUPPORTED;`);
  s=s.replace(`  const supportEvidence = supportIds.map((id) => evidenceById.get(String(id)) || { id, title: id, status: STATUS.SUPPORTED });
  const contradictionEvidence = contradictionIds.map((id) => evidenceById.get(String(id)) || { id, title: id, status: STATUS.UNKNOWN });`, `  const supportEvidence = supportIds.map((id) => evidenceById.get(String(id))).filter(Boolean);
  const contradictionEvidence = contradictionIds.map((id) => evidenceById.get(String(id))).filter(Boolean);
  const unresolvedSupportEvidenceIds = supportIds.filter((id) => !evidenceById.has(String(id)));
  const unresolvedContradictionEvidenceIds = contradictionIds.filter((id) => !evidenceById.has(String(id)));`);
  s=s.replace(`    supportEvidence,
    contradictionEvidence,`, `    supportEvidence,
    contradictionEvidence,
    unresolvedSupportEvidenceIds,
    unresolvedContradictionEvidenceIds,
    provenanceError: unresolvedSupportEvidenceIds.length || unresolvedContradictionEvidenceIds.length ? 'unresolved-evidence-reference' : null,`);
  write(p,s);
}

// #338 — ELF PT_LOAD invariants are enforced before mapping.
{
  const p='js/binary/elf.js'; let s=read(p);
  s=s.replace(`parseProgramHeaders(header, bytes, image);`, `parseProgramHeaders(header, bytes, image, BigInt(bytes.byteLength));`);
  s=s.replace(`function parseProgramHeaders(header, bytes, image) {`, `function parseProgramHeaders(header, bytes, image, fileLength = BigInt(bytes.byteLength)) {`);
  const add=`    if (ph.type === PT_LOAD) {
      const seg = image.addSegment({`;
  const repl=`    if (ph.type === PT_LOAD) {
      if (ph.filesz > ph.memsz) throw new BinaryFormatError('ELF PT_LOAD p_filesz exceeds p_memsz');
      if (ph.offset < 0n || ph.filesz < 0n || ph.offset > fileLength || ph.filesz > fileLength - ph.offset) throw new BinaryFormatError('ELF PT_LOAD file range exceeds input');
      const seg = image.addSegment({`;
  if(!s.includes(add)) throw new Error('ELF PT_LOAD anchor missing'); s=s.replace(add,repl); write(p,s);
}

// #339 — only real COFF function type creates a high-confidence function seed.
{
  const p='js/binary/pe-loader.js'; let s=read(p);
  s=s.replace(`    const functionLike = !!(type & 0x20) || (sec && sec.perms.execute && storage === 2);`, `    const functionLike = !!(type & 0x20);\n    const executableExternal = !!(!functionLike && sec && sec.perms.execute && storage === 2);`);
  s=s.replace(`      kind: functionLike ? 'function' : 'object',`, `      kind: functionLike ? 'function' : executableExternal ? 'label' : 'object',`);
  s=s.replace(`    if (functionLike && address != null) image.functions.push(functionSeed(address, { name, source: 'coff-symbol', confidence: 0.98 }));`, `    if (functionLike && address != null) image.functions.push(functionSeed(address, { name, source: 'coff-symbol', confidence: 0.98 }));`);
  write(p,s);
}

// #340/#341 — Mach-O segment/section and LC_FUNCTION_STARTS invariants.
{
  const p='js/binary/macho.js'; let s=read(p);
  s=s.replace(`parseSegment64(r, p, cmdsize, image, segmentOrder)`, `parseSegment64(r, p, cmdsize, image, segmentOrder, BigInt(bytes.byteLength))`);
  s=s.replace(`parseSegment32(r, p, cmdsize, image, segmentOrder)`, `parseSegment32(r, p, cmdsize, image, segmentOrder, BigInt(bytes.byteLength))`);
  s=s.replace(`function parseSegment64(r, p, cmdsize, image, order) {`, `function parseSegment64(r, p, cmdsize, image, order, fileLength) {`);
  s=s.replace(`function parseSegment32(r, p, cmdsize, image, order) {`, `function parseSegment32(r, p, cmdsize, image, order, fileLength) {`);
  const seg64=`  const nsects = r.u32(p + 64);`;
  s=s.replace(seg64, `  if (fileSize > size) throw new Error('segment filesize exceeds vmsize');\n  if (fileOffset > fileLength || fileSize > fileLength - fileOffset) throw new Error('segment file range exceeds input');\n${seg64}`);
  const seg32=`  const nsects = r.u32(p + 48);`;
  s=s.replace(seg32, `  if (fileSize > size) throw new Error('segment filesize exceeds vmsize');\n  if (fileOffset > fileLength || fileSize > fileLength - fileOffset) throw new Error('segment file range exceeds input');\n${seg32}`);
  const sec64=`    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;
    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: BigInt(offset), fileSize: zeroFill ? 0n : ssize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });`;
  const sec64new=`    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;
    const soff=BigInt(offset);
    if (saddr < address || ssize > size || saddr - address > size - ssize) throw new Error('section VM range escapes segment');
    if (!zeroFill && (soff < fileOffset || soff > fileOffset + fileSize || ssize > fileOffset + fileSize - soff || soff > fileLength || ssize > fileLength - soff)) throw new Error('section file range escapes segment/input');
    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: soff, fileSize: zeroFill ? 0n : ssize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });`;
  if(!s.includes(sec64)) throw new Error('MachO sec64 anchor'); s=s.replace(sec64,sec64new);
  const sec32=`    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;
    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: BigInt(offset), fileSize: zeroFill ? 0n : ssize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });`;
  if(!s.includes(sec32)) throw new Error('MachO sec32 anchor'); s=s.replace(sec32,sec64new);
  s=s.replace(`  const hadFunctionStarts = !!linkeditData.functionStarts;
  if (linkeditData.functionStarts) parseFunctionStarts(r, linkeditData.functionStarts, image);`, `  const validFunctionStarts = linkeditData.functionStarts ? parseFunctionStarts(r, linkeditData.functionStarts, image) : 0;\n  const hadFunctionStarts = validFunctionStarts > 0;`);
  const oldFn=`function parseFunctionStarts(r, dc, image) {
  if (!dc.size) return;
  r.check(dc.offset, dc.size);
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let address = image.imageBase;
  while (p < end) {
    const [delta, next] = readUleb(r, p, end);
    p = next;
    if (delta === 0n) break;
    address += delta;
    image.functions.push(functionSeed(address, { source: 'function_starts', confidence: 0.995 }));
  }
}`;
  const newFn=`function parseFunctionStarts(r, dc, image) {
  if (!dc.size) return 0;
  r.check(dc.offset, dc.size);
  let p = dc.offset, count = 0;
  const end = dc.offset + dc.size;
  let address = image.imageBase;
  const alignment = image.arch === 'arm64' ? 4n : 1n;
  while (p < end) {
    const [delta, next] = readUleb(r, p, end); p = next;
    if (delta === 0n) break;
    const nextAddress = address + delta;
    if (nextAddress <= address) { image.warnings.push('LC_FUNCTION_STARTS overflow/non-monotonic delta'); break; }
    address = nextAddress;
    const exec = image.segments.find((seg)=>seg.perms.execute && address >= seg.address && address < seg.address + seg.size);
    if (!exec || address % alignment !== 0n) { image.warnings.push('LC_FUNCTION_STARTS rejected non-executable/misaligned start 0x'+address.toString(16)); continue; }
    image.functions.push(functionSeed(address, { source: 'function_starts', confidence: 0.995 })); count++;
  }
  return count;
}`;
  if(!s.includes(oldFn)) throw new Error('function starts anchor missing'); s=s.replace(oldFn,newFn); write(p,s);
}

// #342 — deadline is an actual pass scheduling boundary; remaining optional work is skipped.
{
  const p='js/decompiler/passes/manager.js'; let s=read(p);
  s=s.replace(`    this.cost = spec.cost || 'medium';`, `    this.cost = spec.cost || 'medium';\n    this.required = !!spec.required;`);
  s=s.replace(`    for (const pass of this.passes) {
      if (!pass.enabled(context, state)) continue;`, `    for (const pass of this.passes) {
      const elapsedBefore = now() - started;
      const remainingMs = Math.max(0, budgetMs - elapsedBefore);
      if (remainingMs <= 0 && !pass.required) { state.degraded = true; state.skipped.push({ name:pass.name, reason:'time-budget' }); continue; }
      if (!pass.enabled(context, state)) continue;`);
  s=s.replace(`      const t0 = now();
      try {
        const result = pass.run(context, state) || {};`, `      const t0 = now();
      try {
        const passContext = { ...context, deadline: started + budgetMs, remainingMs, signal: context.signal || null };
        const result = pass.run(passContext, state) || {};`);
  write(p,s);
}

// #343/#344 — semantic AST identity plus bounded/iterative counting and traversal-depth guard.
{
  const p='js/decompiler/ast/nodes.js'; let s=read(p);
  s=s.replace(`export function nodeCount(node) {
  if (!node || typeof node !== 'object') return 0;
  let n = 1;
  mapChildren(node, (c) => { n += nodeCount(c); return c; });
  return n;
}`, `export function nodeCount(node, limit = Number.POSITIVE_INFINITY) {
  if (!node || typeof node !== 'object') return 0;
  let n=0; const stack=[node];
  while(stack.length){const cur=stack.pop(); if(!cur||typeof cur!=='object')continue; if(++n>limit)return n; for(const child of semanticChildren(cur)) stack.push(child);}
  return n;
}
function semanticChildren(node) {
  switch(node?.k){
    case 'unary': case 'cast': case 'deref': return [node.arg];
    case 'binary': case 'cmp': return [node.left,node.right];
    case 'select': return [node.condition,node.yes,node.no];
    case 'field': return [node.base];
    case 'index': return [node.base,node.index];
    case 'address': return [node.base,node.index];
    case 'intrinsic': return node.args||[];
    case 'call': return [node.callee,...(node.args||[])];
    default:return [];
  }
}`);
  // semantic fields that old structuralKey omitted.
  s=s.replace(`    case 'field': return \`f:\${node.pointer ? 'p' : 'v'}:\${structuralKey(node.base)}:\${node.offset}:\${node.name || ''}\`;`, `    case 'field': return \`f:\${node.pointer ? 'p' : 'v'}:\${structuralKey(node.base)}:\${node.offset}:\${node.name || ''}:\${node.bits ?? ''}:\${node.signed ?? ''}:\${node.volatile ? 1 : 0}\`;`);
  s=s.replace(`    case 'index': return \`i:\${structuralKey(node.base)}:\${structuralKey(node.index)}:\${node.scale}\`;`, `    case 'index': return \`i:\${structuralKey(node.base)}:\${structuralKey(node.index)}:\${node.scale}:\${node.bits ?? ''}:\${node.signed ?? ''}:\${node.volatile ? 1 : 0}\`;`);
  s=s.replace(`    case 'load': return \`l:\${locationKey(node.location)}:\${node.bits}\`;`, `    case 'load': return \`l:\${locationKey(node.location)}:\${node.bits}:\${node.signed ?? ''}:\${node.volatile ? 1 : 0}:\${node.extend || ''}\`;`);
  s=s.replace(`    case 'call': return \`c:\${structuralKey(node.callee)}:\${node.args.map(structuralKey).join(',')}\`;`, `    case 'call': return \`c:\${structuralKey(node.callee)}:\${node.args.map(structuralKey).join(',')}:\${node.bits ?? ''}:\${node.signed ?? ''}:\${node.returnClass || node.type?.kind || ''}\`;`);
  // hard recursion guard in canonicalization; deep trees degrade to a stable bounded suffix instead of overflowing the JS stack.
  s=s.replace(`export function structuralKey(node) {
  if (!node) return 'null';`, `export function structuralKey(node, depth = 0) {
  if (!node) return 'null';
  if (depth >= 192) return \`deep:\${node.k || typeof node}:\${node.bits ?? ''}:\${node.signed ?? ''}\`;`);
  s=s.replaceAll(`structuralKey(node.arg)`, `structuralKey(node.arg, depth + 1)`);
  s=s.replaceAll(`structuralKey(node.left)`, `structuralKey(node.left, depth + 1)`);
  s=s.replaceAll(`structuralKey(node.right)`, `structuralKey(node.right, depth + 1)`);
  s=s.replaceAll(`structuralKey(node.condition)`, `structuralKey(node.condition, depth + 1)`);
  s=s.replaceAll(`structuralKey(node.yes)`, `structuralKey(node.yes, depth + 1)`);
  s=s.replaceAll(`structuralKey(node.no)`, `structuralKey(node.no, depth + 1)`);
  s=s.replaceAll(`structuralKey(node.base)`, `structuralKey(node.base, depth + 1)`);
  s=s.replaceAll(`structuralKey(node.index)`, `structuralKey(node.index, depth + 1)`);
  s=s.replace(`node.args.map(structuralKey)`, `node.args.map((x)=>structuralKey(x, depth + 1))`);
  s=s.replace(`structuralKey(node.callee)`, `structuralKey(node.callee, depth + 1)`);
  write(p,s);
}
{
  const p='js/decompiler/rewrite/engine.js'; let s=read(p);
  s=s.replace(`if (nodeCount(candidate) > this.nodeBudget)`, `if (nodeCount(candidate, this.nodeBudget) > this.nodeBudget)`);
  s=s.replace(`    const visit = (n) => {`, `    const visit = (n, depth = 0) => {\n      if (depth >= 192) { state.degraded = true; state.warnings?.push?.('rewrite depth budget reached'); return n; }`);
  s=s.replace(`      let out = mapChildren(n, visit);`, `      let out = mapChildren(n, (child)=>visit(child, depth + 1));`);
  write(p,s);
}

// #345 — algebraic rewrites may discard operands only when the discarded subtree is pure.
{
  const p='js/decompiler/rewrite/rules.js'; let s=read(p);
  s=s.replace(`when: (n) => n.k === 'binary' && n.op === 'mul' && isZero(n.right),`, `when: (n) => n.k === 'binary' && n.op === 'mul' && isZero(n.right) && isPure(n.left),`);
  s=s.replace(`when: (n) => n.k === 'binary' && n.op === 'mul' && isZero(n.left),`, `when: (n) => n.k === 'binary' && n.op === 'mul' && isZero(n.left) && isPure(n.right),`);
  s=s.replace(`when: (n) => n.k === 'select' && sameExpr(n.yes, n.no),`, `when: (n) => n.k === 'select' && sameExpr(n.yes, n.no) && isPure(n.condition),`);
  write(p,s);
}

// #346/#347 — precedence-safe MADD intrinsic and width-correct >64-bit integer literals.
{
  const p='js/decompiler/pretty/c.js'; let s=read(p);
  s=s.replace(`function integerText(node) {
  let n = BigInt(node.value);
  const bits = Number(node.bits || 64);
  if (node.signed === true) n = BigInt.asIntN(Math.min(bits, 64), n);
  else n = BigInt.asUintN(Math.min(bits, 64), n);`, `function integerText(node) {
  let n = BigInt(node.value);
  const bits = Math.max(1, Number(node.bits || 64));
  if (bits > 64) {
    const u = BigInt.asUintN(bits, n), hi = u >> 64n, lo = BigInt.asUintN(64, u);
    const wide = \`(((unsigned __int128)0x\${hi.toString(16).toUpperCase()}ULL << 64) | 0x\${lo.toString(16).toUpperCase()}ULL)\`;
    return node.signed === true ? \`((__int128)\${wide})\` : wide;
  }
  if (node.signed === true) n = BigInt.asIntN(bits, n);
  else n = BigInt.asUintN(bits, n);`);
  s=s.replace(`    if (node.name === 'MADD' && args.length === 3) return \`${args[0]} * ${args[1]} + ${args[2]}\`;`, `    if (node.name === 'MADD' && args.length === 3) { const text=\`${args[0]} * ${args[1]} + ${args[2]}\`; return parentPrec > PRECEDENCE.add ? \`(${text})\` : text; }`);
  write(p,s);
}

// #348/#350/#351 — memory location remains AST; conditional aliases retain assembler semantics; no effectful load-forward duplication.
{
  const p='js/decompiler/pipeline-core.js'; let s=read(p);
  s=s.replace(`import { expr, mergeSource, sourceOf, mapChildren, structuralKey, sameExpr } from './ast/nodes.js';`, `import { expr, mergeSource, sourceOf, mapChildren, structuralKey, sameExpr, isPure } from './ast/nodes.js';`);
  s=s.replace(`    return { kind: 'field', key: loc.key, offset: off, base, name, text: \`${printExpression(base)}->${name}\` };`, `    const node = expr.field(base, off, name, true, inst?.size ? Number(inst.size)*8 : 64, inst?.signed ?? null, origin(inst));\n    return { kind: 'field', key: loc.key, offset: off, base, name, node, text: printExpression(node) };`);
  s=s.replace(`    if (Number(addr.size || inst?.size || 0) === scale) return { kind: 'index', key: loc.key, base, index, scale, text: \`${printExpression(base)}[${printExpression(index)}]\` };`, `    if (Number(addr.size || inst?.size || 0) === scale) { const node=expr.index(base,index,scale,inst?.size?Number(inst.size)*8:64,inst?.signed??null,origin(inst)); return { kind:'index',key:loc.key,base,index,scale,node,text:printExpression(node) }; }`);
  // use AST location node for load expression if available.
  s=s.replace(`        out = expr.load(location, v.bits || d.dst?.bits || 64, signedFor(state, v), origin(d, v));`, `        out = location.node || expr.load(location, v.bits || d.dst?.bits || 64, signedFor(state, v), origin(d, v));`);
  // direct alias semantics (assembler condition): true arm applies operation.
  s=s.replace(`  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));`, `  if (d.sub === 'cinc') return expr.select(condition, expr.binary('add', t, expr.constant(1, t.bits), t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state,d.dst), origin(d,d.dst));\n  if (d.sub === 'cneg') return expr.select(condition, expr.unary('neg', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state,d.dst), origin(d,d.dst));\n  if (d.sub === 'cinv') return expr.select(condition, expr.unary('not', t, t.bits, t.signed), t, d.dst?.bits || t.bits, signedFor(state,d.dst), origin(d,d.dst));\n  if (d.sub === 'inc') return expr.select(condition, t, expr.binary('add', f, expr.constant(1, f.bits), f.bits, f.signed), d.dst?.bits || t.bits, signedFor(state, d.dst), origin(d, d.dst));`);
  // Forward a reaching store only when substituting it cannot duplicate/reorder an effectful expression.
  s=s.replace(`      if (d.reachingStore) out = buildArg(d.reachingStore.args?.[0], state);`, `      if (d.reachingStore) { const forwarded=buildArg(d.reachingStore.args?.[0], state); if (isPure(forwarded)) out=forwarded; }`);
  write(p,s);
}

// #349 — physical x0-x7 reuse is not argument identity; only explicit IR args seed ABI groups.
{
  const p='js/decompiler/types/high-variables.js'; let s=read(p);
  s=s.replace(`function isArg(v) { return v?.kind === 'arg' || /^x[0-7]$/.test(v?.reg || ''); }`, `function isArg(v) { return v?.kind === 'arg' || v?.origin?.kind === 'arg' || v?.abiOrigin === 'argument'; }`);
  write(p,s);
}

console.log('issues 334-351 patches applied');
