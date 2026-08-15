import fs from 'node:fs';
function edit(path,fn){const a=fs.readFileSync(path,'utf8'),b=fn(a);if(a===b)throw new Error('no change '+path);fs.writeFileSync(path,b)}
function once(s,a,b,label){const i=s.indexOf(a);if(i<0)throw new Error('missing '+label);if(s.indexOf(a,i+a.length)>=0)throw new Error('ambiguous '+label);return s.slice(0,i)+b+s.slice(i+a.length)}

// #367: FCMP/FCMPE have no destination operand; compare ops[0] with ops[1].
edit('js/emu.js',s=>once(s,
`    const a = this.fget(ops[1]);
    const b = ops[2] ? this.fget(ops[2]) : 0;
    if (mn === 'fmov') {`,
`    if (mn === 'fcmp' || mn === 'fcmpe') {
      const lhs = this.fget(ops[0]);
      const rhs = ops[1]?.k === 'imm'
        ? (ops[1].float != null ? Number(ops[1].float) : Number(ops[1].value ?? 0n))
        : this.fget(ops[1]);
      if (Number.isNaN(lhs) || Number.isNaN(rhs)) this.nzcv = { n:false, z:false, c:true, v:true };
      else if (lhs < rhs) this.nzcv = { n:true, z:false, c:false, v:false };
      else if (lhs === rhs) this.nzcv = { n:false, z:true, c:true, v:false };
      else this.nzcv = { n:false, z:false, c:true, v:false };
      return null;
    }
    const a = this.fget(ops[1]);
    const b = ops[2] ? this.fget(ops[2]) : 0;
    if (mn === 'fmov') {`,'#367 fcmp operand layout'));
edit('js/emu.js',s=>once(s,
`    if (mn === 'fcmp' || mn === 'fcmpe') {
      const rhs = ops[1] && ops[1].k === 'imm' ? 0 : b;
      const lhs = a;
      if (Number.isNaN(lhs) || Number.isNaN(rhs)) this.nzcv = { n:false, z:false, c:true, v:true };
      else this.nzcv = { n: lhs < rhs, z: lhs === rhs, c: lhs >= rhs, v:false };
      return null;
    }
`,``,'#367 remove stale fcmp block'));

// #399: scan the two possible UTF-16 byte alignments independently so a false
// candidate on one alignment cannot skip a real string on the other.
edit('js/binary/strings.js',s=>once(s,
`    if(!includeUtf16) continue;
    for(let p=start;p+1<end;){
      const first=utf16At(bytes,p,end); if(!first||!printableCodePoint(first.cp)){p++;continue;}
      const s=p; let q=p, chars=0;
      while(q+1<end&&chars<max){ const x=utf16At(bytes,q,end); if(!x||!printableCodePoint(x.cp)) break; q+=x.bytes; chars++; }
      if(chars>=min) emit(image,out,seen,s,q-s,'utf16le',range.section);
      p=Math.max(q+(q<end?2:0),p+1);
    }`,
`    if(!includeUtf16) continue;
    for(let parity=0;parity<2;parity++){
      let p=start + ((parity - (start & 1) + 2) & 1);
      while(p+1<end){
        const first=utf16At(bytes,p,end); if(!first||!printableCodePoint(first.cp)){p+=2;continue;}
        const s=p; let q=p, chars=0;
        while(q+1<end&&chars<max){ const x=utf16At(bytes,q,end); if(!x||!printableCodePoint(x.cp)) break; q+=x.bytes; chars++; }
        if(chars>=min) emit(image,out,seen,s,q-s,'utf16le',range.section);
        p=Math.max(q+(q<end?2:0),p+2);
      }
    }`,'#399 independent utf16 alignments'));

edit('tests/issues-350-399.mjs',s=>{
  s=once(s,`eq(out[0].size,null)`,`ok(out[0].size==null)`,'#398 nullable extent assertion');
  return s;
});
