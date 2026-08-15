from pathlib import Path
p=Path('tests/issues-434-450-regressions.mjs')
s=p.read_text()
old="""  const r=new ByteView(bytes);
  const imports=[{sites:[]},{sites:[]}];
  const image={imageBase:BASE,metadata:{chainedFixups:{}},warnings:[],addressToOffset:(a)=>a-BASE};
  parseChainedBindingSites(r,{offset:0,size:0x80},image,imports);
  assert.equal(imports[0].sites.length,1); assert.equal(imports[1].sites.length,1);"""
new="""  const r=new ByteView(bytes);
  const imports=[{sites:[]},{sites:[]}];
  const segment={address:BASE+0x100n,size:0x1000n,fileOffset:0x100n,fileSize:0x100n};
  const image={imageBase:BASE,segments:[segment],metadata:{chainedFixups:{}},warnings:[],addressToOffset:(a)=>a-BASE};
  parseChainedBindingSites(r,{offset:0,size:0x80},image,imports,[segment]);
  assert.equal(imports[0].sites.length,1); assert.equal(imports[1].sites.length,1);"""
if old not in s: raise SystemExit('#446 fixture anchor missing')
p.write_text(s.replace(old,new,1))
