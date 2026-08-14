from pathlib import Path

p=Path('js/blocks.js')
t=p.read_text()
marker='const API_TABLE = ['
if t.count(marker)!=1: raise SystemExit('API_TABLE marker mismatch')
precise=r'''const PRECISE_API_TABLE = [
  // Memory APIs whose ABI differs from the historical broad-family fallback.
  { id:'bcopy', re:/^_?bcopy$/i, cat:'memory', args:['src','dst','size'], ret:null, effect:'copy' },
  { id:'memcpy_chk', re:/^_?__(memcpy|memmove)_chk$/i, cat:'memory', args:['dst','src','size','object_size'], ret:'ptr', effect:'copy' },
  { id:'memset_chk', re:/^_?__memset_chk$/i, cat:'memory', args:['dst','fill','size','object_size'], ret:'ptr', effect:'fill' },
  { id:'bzero', re:/^_?bzero$/i, cat:'memory', args:['dst','size'], ret:null, effect:'fill' },
  { id:'calloc', re:/^_?calloc$/i, cat:'memory', args:['count','size'], ret:'heap', effect:'alloc' },

  // Bounded/string conversion APIs. Keep every ABI-significant operand.
  { id:'strnlen', re:/^_?strnlen$/i, cat:'string', args:['str','maxlen'], ret:'length', effect:'read' },
  { id:'strncmp', re:/^_?(strncmp|strncasecmp)$/i, cat:'string', args:['a','b','size'], ret:'diff', effect:'compare' },
  { id:'strncpy', re:/^_?strncpy$/i, cat:'string', args:['dst','src','size'], ret:'ptr', effect:'copy' },
  { id:'strlcpy', re:/^_?strlcpy$/i, cat:'string', args:['dst','src','dst_size'], ret:'length', effect:'copy' },
  { id:'strcpy_chk', re:/^_?__strcpy_chk$/i, cat:'string', args:['dst','src','object_size'], ret:'ptr', effect:'copy' },
  { id:'strncpy_chk', re:/^_?__strncpy_chk$/i, cat:'string', args:['dst','src','size','object_size'], ret:'ptr', effect:'copy' },
  { id:'strncat', re:/^_?strncat$/i, cat:'string', args:['dst','src','size'], ret:'ptr', effect:'copy' },
  { id:'strlcat', re:/^_?strlcat$/i, cat:'string', args:['dst','src','dst_size'], ret:'length', effect:'copy' },
  { id:'sprintf', re:/^_?sprintf$/i, cat:'string', args:['dst','format'], formatArg:1, variadic:true, ret:'length', effect:'format' },
  { id:'snprintf', re:/^_?snprintf$/i, cat:'string', args:['dst','size','format'], formatArg:2, variadic:true, ret:'length', effect:'format' },
  { id:'asprintf', re:/^_?asprintf$/i, cat:'string', args:['dst_ptr','format'], formatArg:1, variadic:true, ret:'length', effect:'format' },
  { id:'vsnprintf', re:/^_?vsnprintf$/i, cat:'string', args:['dst','size','format','va_list'], formatArg:2, ret:'length', effect:'format' },
  { id:'sprintf_chk', re:/^_?__sprintf_chk$/i, cat:'string', args:['dst','flags','object_size','format'], formatArg:3, variadic:true, ret:'length', effect:'format' },
  { id:'snprintf_chk', re:/^_?__snprintf_chk$/i, cat:'string', args:['dst','size','flags','object_size','format'], formatArg:4, variadic:true, ret:'length', effect:'format' },
  { id:'strtol', re:/^_?(strtol|strtoul)$/i, cat:'string', args:['str','endptr','base'], ret:'number', effect:'convert' },
  { id:'strtod', re:/^_?strtod$/i, cat:'string', args:['str','endptr'], ret:'number', effect:'convert' },

  // Logging format-string positions are ABI-specific.
  { id:'printf', re:/^_?printf$/i, cat:'log', args:['format'], formatArg:0, variadic:true, ret:'status', effect:'log' },
  { id:'fprintf', re:/^_?fprintf$/i, cat:'log', args:['stream','format'], formatArg:1, variadic:true, ret:'status', effect:'log' },
  { id:'puts', re:/^_?puts$/i, cat:'log', args:['str'], ret:'status', effect:'log' },
  { id:'putchar', re:/^_?putchar$/i, cat:'log', args:['char'], ret:'status', effect:'log' },
  { id:'NSLog', re:/^_?NSLog$/i, cat:'log', args:['format'], formatArg:0, variadic:true, ret:null, effect:'log' },
  { id:'os_log', re:/^_?os_log$/i, cat:'log', args:['log','format'], formatArg:1, variadic:true, ret:null, effect:'log' },
  { id:'os_log_impl', re:/^_?_os_log_impl$/i, cat:'log', args:['dso','log','type','format','buffer','size'], formatArg:3, ret:null, effect:'log' },
  { id:'syslog', re:/^_?syslog$/i, cat:'log', args:['priority','format'], formatArg:1, variadic:true, ret:null, effect:'log' },

  // Objective-C ARC helpers: retain-like and release/store operations do not share a return contract.
  { id:'objc_retain', re:/^_?objc_retain$/i, cat:'objc', args:['object'], ret:'object', effect:'refcount' },
  { id:'objc_release', re:/^_?objc_release$/i, cat:'objc', args:['object'], ret:null, effect:'refcount' },
  { id:'objc_autorelease', re:/^_?objc_autorelease$/i, cat:'objc', args:['object'], ret:'object', effect:'refcount' },
  { id:'objc_storeStrong', re:/^_?objc_storeStrong$/i, cat:'objc', args:['location','object'], ret:null, effect:'refcount' },
  { id:'objc_arc_return', re:/^_?objc_(retainAutorelease(?:ReturnValue)?|retainAutoreleasedReturnValue|autoreleaseReturnValue|claimAutoreleasedReturnValue|unsafeClaimAutoreleasedReturnValue)$/i, cat:'objc', args:['object'], ret:'object', effect:'refcount' },
  { id:'objc_alloc', re:/^_?(objc_alloc|objc_allocWithZone|objc_opt_new)$/i, cat:'objc', args:['class'], ret:'object', effect:'alloc' },

  // Swift ownership/allocation helpers also have distinct ABI effects.
  { id:'swift_retain', re:/^_?swift_(retain|bridgeObjectRetain)$/i, cat:'runtime', args:['object'], ret:'object', effect:'refcount' },
  { id:'swift_release', re:/^_?swift_(release|bridgeObjectRelease)$/i, cat:'runtime', args:['object'], ret:null, effect:'refcount' },
  { id:'swift_allocObject', re:/^_?swift_allocObject$/i, cat:'runtime', args:['metadata','size','align_mask'], ret:'object', effect:'alloc' },

  // POSIX/stdio file calls.
  { id:'open', re:/^_?open$/i, cat:'io', args:['path','flags','mode'], variadic:true, ret:'handle', effect:'io' },
  { id:'openat', re:/^_?openat$/i, cat:'io', args:['dirfd','path','flags','mode'], variadic:true, ret:'handle', effect:'io' },
  { id:'fopen', re:/^_?fopen$/i, cat:'io', args:['path','mode'], ret:'handle', effect:'io' },
  { id:'fread', re:/^_?fread$/i, cat:'io', args:['ptr','size','count','stream'], ret:'count', effect:'io' },
  { id:'fwrite', re:/^_?fwrite$/i, cat:'io', args:['ptr','size','count','stream'], ret:'count', effect:'io' },
  { id:'read', re:/^_?read$/i, cat:'io', args:['fd','buffer','count'], ret:'count', effect:'io' },
  { id:'write', re:/^_?write$/i, cat:'io', args:['fd','buffer','count'], ret:'count', effect:'io' },
  { id:'close', re:/^_?close$/i, cat:'io', args:['fd'], ret:'status', effect:'io' },
  { id:'fclose', re:/^_?fclose$/i, cat:'io', args:['stream'], ret:'status', effect:'io' },
  { id:'lseek', re:/^_?lseek$/i, cat:'io', args:['fd','offset','whence'], ret:'offset', effect:'io' },
  { id:'stat', re:/^_?stat$/i, cat:'io', args:['path','statbuf'], ret:'status', effect:'io' },
  { id:'unlink', re:/^_?unlink$/i, cat:'io', args:['path'], ret:'status', effect:'io' },
  { id:'mkdir', re:/^_?mkdir$/i, cat:'io', args:['path','mode'], ret:'status', effect:'io' },
  { id:'remove', re:/^_?remove$/i, cat:'io', args:['path'], ret:'status', effect:'io' },

  // Socket APIs. Preserve every address/length/flags operand.
  { id:'socket', re:/^_?socket$/i, cat:'network', args:['domain','type','protocol'], ret:'handle', effect:'network' },
  { id:'connect', re:/^_?connect$/i, cat:'network', args:['socket','address','address_len'], ret:'status', effect:'network' },
  { id:'bind', re:/^_?bind$/i, cat:'network', args:['socket','address','address_len'], ret:'status', effect:'network' },
  { id:'listen', re:/^_?listen$/i, cat:'network', args:['socket','backlog'], ret:'status', effect:'network' },
  { id:'accept', re:/^_?accept$/i, cat:'network', args:['socket','address','address_len_ptr'], ret:'handle', effect:'network' },
  { id:'send', re:/^_?send$/i, cat:'network', args:['socket','buffer','length','flags'], ret:'count', effect:'network' },
  { id:'sendto', re:/^_?sendto$/i, cat:'network', args:['socket','buffer','length','flags','address','address_len'], ret:'count', effect:'network' },
  { id:'recv', re:/^_?recv$/i, cat:'network', args:['socket','buffer','length','flags'], ret:'count', effect:'network' },
  { id:'recvfrom', re:/^_?recvfrom$/i, cat:'network', args:['socket','buffer','length','flags','address','address_len_ptr'], ret:'count', effect:'network' },
  { id:'getaddrinfo', re:/^_?getaddrinfo$/i, cat:'network', args:['node','service','hints','result_ptr'], ret:'status', effect:'network' },
];

'''
t=t.replace(marker,precise+marker)
old="""export function apiInfo(name) {
  if (!name) return null;
  const clean = String(name).trim();
  for (const a of API_TABLE) {
    if (a.re.test(clean)) return a;
  }
"""
new="""export function apiInfo(name) {
  if (!name) return null;
  const clean = String(name).trim();
  for (const a of PRECISE_API_TABLE) {
    if (a.re.test(clean)) return a;
  }
  for (const a of API_TABLE) {
    if (a.re.test(clean)) return a;
  }
"""
if t.count(old)!=1: raise SystemExit('apiInfo block mismatch')
t=t.replace(old,new)
# #128: parser failures remain represented and are surfaced as structured diagnostics.
old="""  let parsed = [];
  try { parsed = parseOperands(opsStr); } catch { parsed = []; }
"""
new="""  let parsed = [];
  let parseError = null;
  try { parsed = parseOperands(opsStr); }
  catch (error) {
    parsed = [];
    parseError = { stage:'operands', message:error?.message || String(error), text:opsStr };
  }
"""
if t.count(old)!=1: raise SystemExit('makeInstruction parse catch mismatch')
t=t.replace(old,new)
old="""    operands: opsStr,
    ops: parsed,
    category: categoryOf(base),
"""
new="""    operands: opsStr,
    ops: parsed,
    parseError,
    category: categoryOf(base),
"""
if t.count(old)!=1: raise SystemExit('instruction object mismatch')
t=t.replace(old,new)
old="""  const insns = [];
  for (const r of source) {
    try { insns.push(makeInstruction(r)); }
    catch { /* 1 行壊れていても解析全体は続ける */ }
  }
"""
new="""  const insns = [];
  const diagnostics = [];
  for (const r of source) {
    try {
      const inst = makeInstruction(r);
      insns.push(inst);
      if (inst.parseError) diagnostics.push({ severity:'warning', row:r.row, address:r.address ?? null, ...inst.parseError });
    } catch (error) {
      diagnostics.push({ severity:'error', stage:'instruction', row:r.row, address:r.address ?? null, message:error?.message || String(error), text:`${r.mn || ''} ${r.ops || ''}`.trim() });
      insns.push({
        row:r.row, address:r.address, mnemonic:r.mn || '', operands:r.ops || '', ops:[], data:false,
        category:'unknown', reads:[], writes:[], role:'other', unknown:true,
        analysisError:{ stage:'instruction', message:error?.message || String(error) },
      });
    }
  }
"""
if t.count(old)!=1: raise SystemExit('semantic model silent catch mismatch')
t=t.replace(old,new)
old="""    truncated,
    instructions: insns,
    basicBlocks: bbInfo.blocks,
"""
new="""    truncated,
    diagnostics,
    instructions: insns,
    basicBlocks: bbInfo.blocks,
"""
if t.count(old)!=1: raise SystemExit('model return mismatch')
t=t.replace(old,new)
p.write_text(t)

Path('tests/issues-113-128.mjs').write_text(r'''import assert from 'node:assert/strict';
import { apiInfo, buildSemanticModel } from '../js/blocks.js';

const args=(name)=>apiInfo(name)?.args;
assert.deepEqual(args('bcopy'),['src','dst','size']);
assert.deepEqual(args('bzero'),['dst','size']);
assert.deepEqual(args('__memcpy_chk'),['dst','src','size','object_size']);
assert.deepEqual(args('calloc'),['count','size']);
assert.deepEqual(args('strnlen'),['str','maxlen']);
assert.deepEqual(args('strncmp'),['a','b','size']);
assert.deepEqual(args('strncpy'),['dst','src','size']);
assert.deepEqual(args('strlcpy'),['dst','src','dst_size']);
assert.deepEqual(args('strncat'),['dst','src','size']);
assert.deepEqual(args('snprintf'),['dst','size','format']);
assert.equal(apiInfo('snprintf').formatArg,2);
assert.deepEqual(args('strtol'),['str','endptr','base']);
assert.deepEqual(args('fprintf'),['stream','format']);
assert.equal(apiInfo('fprintf').formatArg,1);
assert.deepEqual(args('_os_log_impl'),['dso','log','type','format','buffer','size']);
assert.equal(apiInfo('_os_log_impl').formatArg,3);
assert.equal(apiInfo('objc_release').ret,null);
assert.deepEqual(args('objc_storeStrong'),['location','object']);
assert.equal(apiInfo('swift_release').ret,null);
assert.deepEqual(args('swift_allocObject'),['metadata','size','align_mask']);
assert.deepEqual(args('read'),['fd','buffer','count']);
assert.deepEqual(args('fread'),['ptr','size','count','stream']);
assert.deepEqual(args('connect'),['socket','address','address_len']);
assert.deepEqual(args('sendto'),['socket','buffer','length','flags','address','address_len']);
assert.deepEqual(args('getaddrinfo'),['node','service','hints','result_ptr']);

// #128: a per-row construction failure can no longer disappear silently.
const evil={row:7,address:0x101cn,get mn(){throw new Error('bad mnemonic')},ops:''};
const model=buildSemanticModel([evil],{startRow:7,endRow:7,rowOfAddress:()=>7});
assert.equal(model.instructions.length,1);
assert.equal(model.instructions[0].unknown,true);
assert.equal(model.diagnostics.length,1);
assert.equal(model.diagnostics[0].severity,'error');
assert.equal(model.diagnostics[0].row,7);
console.log('issues-113-128: ok');
''')
print('patched issues 113-128')
