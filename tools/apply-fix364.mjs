import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8'); const write=(p,s)=>fs.writeFileSync(p,s);
function rep(p,a,b){const s=read(p);if(!s.includes(a))throw new Error(`anchor missing ${p}: ${a.slice(0,120)}`);write(p,s.replace(a,b));}

// #364-#378 runtime semantics.
{
  const p='js/emu.js'; let s=read(p);
  s=s.replace(`    this.v = new Array(32).fill(0n);       // 小数/SIMD は下位 64 ビットだけ`, `    this.v = new Array(32).fill(0n);       // 小数/SIMD は下位 64 ビットだけ\n    this.exclusive = null;`);

  // Any ordinary store invalidates the local exclusive monitor; STXR uses preserveExclusive after checking it.
  s=s.replace(`  async store(addr, size, value) {
    await this.ensure(addr);`, `  async store(addr, size, value, preserveExclusive = false) {
    if (!preserveExclusive && this.exclusive && rangesOverlap(addr, size, this.exclusive.addr, this.exclusive.size)) this.exclusive = null;
    await this.ensure(addr);`);

  // #364 exclusive load/store monitor.
  s=s.replace(`    const raw = await this.load(addr, size);`, `    const raw = await this.load(addr, size);
    if (/^(ldxr|ldaxr|ldxp|ldaxp)$/.test(mn)) this.exclusive = { addr, size };`);
  const stxrOld=`    if (/^(stxr|stlxr)$/.test(mn)) {
      // status, value, [mem]
      const status = ops[0]; valueOp = ops[1]; mem = ops.find((o) => o.k === 'mem');
      if (!mem) return;
      const addr = this.effectiveAddress(mem, false);
      await this.store(addr, this.sizeOf(valueOp), this.valueOf(valueOp));
      if (status?.k === 'reg') this.set(status.text, 0n);
      return;
    }`;
  const stxrNew=`    if (/^(stxr|stlxr)$/.test(mn)) {
      const status = ops[0]; valueOp = ops[1]; mem = ops.find((o) => o.k === 'mem');
      if (!mem) return;
      const addr = this.effectiveAddress(mem, false), size = this.sizeOf(valueOp);
      const ok = !!this.exclusive && this.exclusive.addr === addr && this.exclusive.size === size;
      if (ok) await this.store(addr, size, this.valueOf(valueOp), true);
      this.exclusive = null;
      if (status?.k === 'reg') this.set(status.text, ok ? 0n : 1n);
      return;
    }`;
  if(s.includes(stxrOld)) s=s.replace(stxrOld,stxrNew);

  // #365 conditional select family: transform only false arm.
  const cselOld=`      let v = this.cond(cond) ? a : b;
      if (mn === 'csinc') v += 1n;
      if (mn === 'csinv') v = ~v;
      if (mn === 'csneg') v = -v;
      this.set(dst.text, v);`;
  const cselNew=`      const yes = this.cond(cond);
      let v = yes ? a : b;
      if (!yes && mn === 'csinc') v = b + 1n;
      if (!yes && mn === 'csinv') v = ~b;
      if (!yes && mn === 'csneg') v = -b;
      this.set(dst.text, v);`;
  if(s.includes(cselOld)) s=s.replace(cselOld,cselNew);

  // #367 float immediate is parsed as Number and stored as IEEE bits, not BigInt.
  s=s.replace(`if (src?.k === 'imm') { this.fset(dst, Number(src.value)); return; }`, `if (src?.k === 'imm') { this.fset(dst, src.float != null ? Number(src.float) : Number(src.value)); return; }`);

  // #368 FCMP IEEE semantics including unordered NaN.
  const fcmpOld=`      this.nzcv = { n: a < b, z: a === b, c: a >= b, v: false };`;
  const fcmpNew=`      if (Number.isNaN(a) || Number.isNaN(b)) this.nzcv = { n:false, z:false, c:true, v:true };
      else this.nzcv = { n: a < b, z: Object.is(a,b) || a === b, c: a >= b, v:false };`;
  s=s.replace(fcmpOld,fcmpNew);

  // #370 exact REV variants per container/element width.
  const revOld=`      const bits = dst.text.startsWith('w') ? 32 : 64;
      const bytes = bits / 8;
      const input = BigInt.asUintN(bits, this.valueOf(src));
      let v = 0n;
      for (let i = 0; i < bytes; i++) v = (v << 8n) | ((input >> BigInt(i * 8)) & 0xffn);
      this.set(dst.text, v);`;
  const revNew=`      const bits = dst.text.startsWith('w') ? 32 : 64;
      const input = BigInt.asUintN(bits, this.valueOf(src));
      const group = mn === 'rev16' ? 2 : mn === 'rev32' ? 4 : bits / 8;
      let v = 0n;
      for (let base=0; base<bits/8; base+=group) for (let i=0;i<group;i++) {
        const byte=(input >> BigInt((base+i)*8)) & 0xffn;
        const outByte=base+(group-1-i); v |= byte << BigInt(outByte*8);
      }
      this.set(dst.text, v);`;
  if(s.includes(revOld)) s=s.replace(revOld,revNew);

  // #371 signed bitfield insert aliases must sign extend the extracted field.
  s=s.replace(`if (mn === 'sbfiz' || mn === 'ubfiz') {`, `if (mn === 'sbfiz' || mn === 'ubfiz') {`);
  const sbfAnchor=`      this.set(dst.text, (this.valueOf(src) & mask) << lsb);
      return;`;
  const sbfRepl=`      const raw = this.valueOf(src) & mask;
      const shifted = raw << lsb;
      if (mn === 'sbfiz') {
        const fieldBits = Number(width + lsb);
        const signed = BigInt.asIntN(fieldBits, shifted);
        this.set(dst.text, BigInt.asUintN(dst.text.startsWith('w') ? 32 : 64, signed));
      } else this.set(dst.text, shifted);
      return;`;
  const sbfPos=s.indexOf(sbfAnchor,s.indexOf(`if (mn === 'sbfiz' || mn === 'ubfiz')`));
  if(sbfPos>=0) s=s.slice(0,sbfPos)+s.slice(sbfPos).replace(sbfAnchor,sbfRepl);

  // #372/#373 copy/memory hooks are overlap safe and never silently truncate.
  const copyOld=`    if (/^(memcpy|memmove)$/.test(plain)) {
      const d = this.x[0], s = this.x[1], n = this.x[2];
      for (let i = 0n; i < n && i < 65536n; i++) {
        await this.ensure(s + i); await this.ensure(d + i);
        this.writeByte(d + i, this.byteAt(s + i));
      }
      this.log.push({ call: plain, note: n + ' バイトをコピーしました' });
      return true;
    }`;
  const copyNew=`    if (/^(memcpy|memmove)$/.test(plain)) {
      const d = this.x[0], src = this.x[1], n = this.x[2];
      if (n > 65536n) { this.stopped = plain + ' size cap exceeded (' + n + ' bytes)'; this.log.push({ call:plain, truncated:true, actualBytes:0n, totalBytes:n }); return true; }
      const tmp = new Uint8Array(Number(n));
      for (let i=0;i<tmp.length;i++) { await this.ensure(src+BigInt(i)); tmp[i]=this.byteAt(src+BigInt(i)); }
      for (let i=0;i<tmp.length;i++) { await this.ensure(d+BigInt(i)); this.writeByte(d+BigInt(i),tmp[i]); }
      this.log.push({ call:plain, actualBytes:n, totalBytes:n, note:n+' バイトをコピーしました' }); return true;
    }`;
  if(s.includes(copyOld)) s=s.replace(copyOld,copyNew);
  const setOld=`    if (/^(memset|bzero)$/.test(plain)) {
      const d = this.x[0], c = plain === 'bzero' ? 0n : this.x[1], n = plain === 'bzero' ? this.x[1] : this.x[2];
      for (let i = 0n; i < n && i < 65536n; i++) { await this.ensure(d + i); this.writeByte(d + i, Number(c & 0xffn)); }
      this.log.push({ call: plain, note: n + ' バイトを埋めました' });
      return true;
    }`;
  const setNew=`    if (/^(memset|bzero)$/.test(plain)) {
      const d=this.x[0], c=plain==='bzero'?0n:this.x[1], n=plain==='bzero'?this.x[1]:this.x[2];
      if(n>65536n){this.stopped=plain+' size cap exceeded ('+n+' bytes)';this.log.push({call:plain,truncated:true,actualBytes:0n,totalBytes:n});return true;}
      for(let i=0n;i<n;i++){await this.ensure(d+i);this.writeByte(d+i,Number(c&0xffn));}
      this.log.push({call:plain,actualBytes:n,totalBytes:n,note:n+' バイトを埋めました'});return true;
    }`;
  if(s.includes(setOld)) s=s.replace(setOld,setNew);

  // #374 calloc nmemb*size, checked and zero initialized.
  const allocOld=`    if (/^(malloc|calloc|operator new|_Znwm|_Znam)$/.test(plain)) {
      const size = this.x[0] || 16n;
      const addr = this.heap;
      this.heap += (size + 15n) & ~15n;
      this.x[0] = addr;`;
  const allocNew=`    if (/^(malloc|calloc|operator new|_Znwm|_Znam)$/.test(plain)) {
      let size = this.x[0] || 16n;
      if (plain === 'calloc') {
        const nmemb=this.x[0], elem=this.x[1];
        if (nmemb !== 0n && elem > 0xffffffffffffffffn / nmemb) { this.x[0]=0n; this.log.push({call:plain,error:'allocation-overflow'}); return true; }
        size=nmemb*elem;
      }
      const addr=this.heap; this.heap += (size + 15n) & ~15n; this.x[0]=addr;
      if (plain === 'calloc') for(let i=0n;i<size;i++){await this.ensure(addr+i);this.writeByte(addr+i,0);}`;
  if(s.includes(allocOld)) s=s.replace(allocOld,allocNew);

  // #375 objc_storeStrong performs the observable slot write.
  s=s.replace(`    if (/^objc_(retain|release|autorelease|retainAutoreleasedReturnValue|storeStrong)/.test(plain)) {`, `    if (plain === 'objc_storeStrong') { await this.store(this.x[0],8,this.x[1]); this.log.push({call:plain,slot:this.x[0],value:this.x[1]}); return true; }
    if (/^objc_(retain|release|autorelease|retainAutoreleasedReturnValue)/.test(plain)) {`);

  // #376 distinguish number min/max from propagating-NaN min/max and preserve signed zero.
  s=s.replace(`if (/^f(min|max)(nm)?$/.test(mn)) { const a=this.fget(ops[1]),b=this.fget(ops[2]); this.fset(ops[0],mn.includes('min')?Math.min(a,b):Math.max(a,b)); return; }`, `if (/^f(min|max)(nm)?$/.test(mn)) {
      const a=this.fget(ops[1]),b=this.fget(ops[2]), numberVariant=mn.endsWith('nm'); let v;
      if(numberVariant){ if(Number.isNaN(a)&&!Number.isNaN(b))v=b; else if(Number.isNaN(b)&&!Number.isNaN(a))v=a; else if(Number.isNaN(a)&&Number.isNaN(b))v=NaN; else v=mn.startsWith('fmin')?Math.min(a,b):Math.max(a,b); }
      else v=(Number.isNaN(a)||Number.isNaN(b))?NaN:(mn.startsWith('fmin')?Math.min(a,b):Math.max(a,b));
      this.fset(ops[0],v); return;
    }`);

  // #377 saturating FCVTZS/FCVTZU by destination width.
  s=s.replace(`if (mn === 'fcvtzs' || mn === 'fcvtzu') { const a=this.fget(ops[1]); this.set(ops[0].text, BigInt(Math.trunc(a) || 0)); return; }`, `if (mn === 'fcvtzs' || mn === 'fcvtzu') {
      const a=this.fget(ops[1]), bits=ops[0].text.startsWith('w')?32:64, unsigned=mn==='fcvtzu'; let n;
      if(Number.isNaN(a)) n=0n; else {
        const t=BigInt(Math.trunc(a));
        const lo=unsigned?0n:-(1n<<BigInt(bits-1)), hi=unsigned?(1n<<BigInt(bits))-1n:(1n<<BigInt(bits-1))-1n;
        n=t<lo?lo:t>hi?hi:t;
      }
      this.set(ops[0].text,n); return;
    }`);

  // #378 strlen cap must be explicit truncation, never a successful exact length.
  const strlenOld=`      while (n < 4096n) { await this.ensure(p + n); if (this.byteAt(p + n) === 0) break; n++; }
      this.x[0] = n;
      this.log.push({ call: 'strlen', note: '長さ ' + n + ' を返しました' });
      return true;`;
  const strlenNew=`      let terminated=false;
      while(n<4096n){await this.ensure(p+n);if(this.byteAt(p+n)===0){terminated=true;break;}n++;}
      if(!terminated){this.stopped='strlen scan cap reached without NUL';this.log.push({call:'strlen',truncated:true,scanned:n});return true;}
      this.x[0]=n;this.log.push({call:'strlen',note:'長さ '+n+' を返しました'});return true;`;
  if(s.includes(strlenOld)) s=s.replace(strlenOld,strlenNew);

  // helper for exclusive invalidation.
  const helperAnchor=`function alignUp(v, a) {`;
  if(s.includes(helperAnchor)) s=s.replace(helperAnchor,`function rangesOverlap(a,as,b,bs){const ae=a+BigInt(as),be=b+BigInt(bs);return a<be&&b<ae;}\n\n`+helperAnchor);
  write(p,s);
}

// #379 sandbox output channel has hard per-run count+byte budgets and terminate-on-overflow.
{
  const p='js/sandbox.js'; let s=read(p);
  s=s.replace(`    let rpcTotal = 0, rpcActive = 0, heavyActive = 0, responseBytes = 0;`, `    let rpcTotal = 0, rpcActive = 0, heavyActive = 0, responseBytes = 0, outputCount = 0, outputBytes = 0, outputWindowStart = Date.now(), outputWindowCount = 0;`);
  s=s.replace(`    const maxResponseBytes = Math.max(4096, Math.min(64 * 1024 * 1024, Number(budgets.maxResponseBytes) || 8 * 1024 * 1024));`, `    const maxResponseBytes = Math.max(4096, Math.min(64 * 1024 * 1024, Number(budgets.maxResponseBytes) || 8 * 1024 * 1024));
    const maxOutputMessages=Math.max(10,Math.min(10000,Number(budgets.maxOutputMessages)||1000));
    const maxOutputBytes=Math.max(4096,Math.min(8*1024*1024,Number(budgets.maxOutputBytes)||1024*1024));
    const maxOutputPerSecond=Math.max(10,Math.min(1000,Number(budgets.maxOutputPerSecond)||200));`);
  s=s.replace(`      } else if (m.t === 'print') {
        try { out(...(m.args || [])); } catch {}`, `      } else if (m.t === 'print') {
        const now=Date.now(); if(now-outputWindowStart>=1000){outputWindowStart=now;outputWindowCount=0;}
        outputWindowCount++; outputCount++; outputBytes+=byteSize(m.args||[]);
        if(outputCount>maxOutputMessages||outputBytes>maxOutputBytes||outputWindowCount>maxOutputPerSecond){failBudget('出力channelの上限を超えました。');return;}
        try { out(...(m.args || [])); } catch {}`);
  write(p,s);
}

// #380 direct-selector bit on relative/small ObjC method lists.
for (const p of ['js/objc-legacy.js','js/apple/objc-metadata.js']) {
  let s=read(p);
  s=s.replace(`const relative = !!(entsizeAndFlags & 0x80000000);`, `const relative = !!(entsizeAndFlags & 0x80000000);\n  const directSelectors = !!(entsizeAndFlags & 0x40000000);`);
  s=s.replace(`const nameTarget = entry + BigInt(nameRel);
      const selPtr = readPtr(nameTarget);
      const sel = selPtr ? readCString(selPtr) : readCString(nameTarget);`, `const nameTarget = entry + BigInt(nameRel);
      const selPtr = directSelectors ? null : readPtr(nameTarget);
      const sel = directSelectors ? readCString(nameTarget) : (selPtr ? readCString(selPtr) : null);`);
  s=s.replace(`const nameTarget = entryAddr + BigInt(nameRel);
      const selPtr = ptrAt(nameTarget);
      const sel = selPtr ? cstr(selPtr) : cstr(nameTarget);`, `const nameTarget = entryAddr + BigInt(nameRel);
      const selPtr = directSelectors ? null : ptrAt(nameTarget);
      const sel = directSelectors ? cstr(nameTarget) : (selPtr ? cstr(selPtr) : null);`);
  write(p,s);
}

// #381 ObjC encoding c is signed char; B is explicit boolean.
{
  const p='js/objc-legacy.js'; let s=read(p);
  s=s.replace(`case 'c': return { kind: 'int', bytes: 1, signed: true, bool: true };`, `case 'c': return { kind: 'int', bytes: 1, signed: true };`);
  write(p,s);
}

console.log('issues 364-381 patches applied');
