from pathlib import Path
p=Path('tools/fix-final-551-554.py')
t=p.read_text()
a=t.index('old="""  function growCalls() {')
b=t.index('p.write_text(s)',a)
replacement=r'''def replace_simple_function(src, name, body):
    start=src.index(f'  function {name}() {{')
    brace=0; end=None
    for i in range(start,len(src)):
        if src[i]=='{': brace+=1
        elif src[i]=='}':
            brace-=1
            if brace==0:
                end=i+1;break
    if end is None: raise SystemExit(f'{name} function boundary missing')
    return src[:start]+body+src[end:]

s=s.replace('const MAX_REFS = 8_000_000;          // データへの参照', 'const MAX_REFS = 8_000_000;          // logical ceiling; byte budget is authoritative\nconst PROGRAM_INDEX_MEMORY_BUDGET = 96 * 1024 * 1024; // iPad-safe shared typed-array peak budget') if 'PROGRAM_INDEX_MEMORY_BUDGET' not in s else s
call_body="""  function growCalls() {
    const size=Math.min(callFrom.length*2,MAX_EDGES); if(size<=callFrom.length)return false;
    const allocation=size*16; if(programResidentBytes()+allocation>PROGRAM_INDEX_MEMORY_BUDGET){callsCapped=true;return false;}
    callFrom=grow64(callFrom,size);callTo=grow64(callTo,size);return true;
  }"""
ref_body="""  function growRefs() {
    const size=Math.min(refFrom.length*2,MAX_REFS);if(size<=refFrom.length)return false;
    const allocation=size*17;if(programResidentBytes()+allocation>PROGRAM_INDEX_MEMORY_BUDGET){refsCapped=true;return false;}
    refFrom=grow64(refFrom,size);refTo=grow64(refTo,size);const k=new Uint8Array(size);k.set(refKind);refKind=k;return true;
  }"""
s=replace_simple_function(s,'growCalls',call_body)
s=replace_simple_function(s,'growRefs',ref_body)
# Insert resident accounting just before growCalls after the arrays exist.
needle='  function growCalls() {'
if 'function programResidentBytes()' not in s:
    s=s.replace(needle,"  function programResidentBytes(){return callFrom.byteLength+callTo.byteLength+refFrom.byteLength+refTo.byteLength+refKind.byteLength+kinds.byteLength;}\n"+needle,1)
'''
t=t[:a]+replacement+t[b:]
p.write_text(t)
