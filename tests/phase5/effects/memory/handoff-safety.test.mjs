import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const P5_1_MEMORY_FORM_HANDOFF=Object.freeze({
  'IMPLEMENTED-IN-P5-2':Object.freeze(['ADD','SUB','CMP','TEST','AND','OR','XOR','NOT','SETcc','CMOVcc']),
  'RESOLVED-IN-P5-I':Object.freeze(['ADC','SBB','INC','DEC','NEG','SHL','SAL','SHR','SAR','ROL','ROR','IMUL','MUL','DIV','IDIV']),
  'OUTSIDE-MANDATORY-CORPUS':Object.freeze([]),
});

test('P5-1/P5-2 overlapping memory families are explicitly classified after integration',()=>{
  const all=Object.values(P5_1_MEMORY_FORM_HANDOFF).flat();
  const required=['ADD','SUB','CMP','TEST','AND','OR','XOR','NOT','ADC','SBB','INC','DEC','NEG','SHL','SAL','SHR','SAR','ROL','ROR','IMUL','MUL','DIV','IDIV','SETcc','CMOVcc'];
  assert.deepEqual([...new Set(all)].sort(),[...required].sort());
  assert.equal(P5_1_MEMORY_FORM_HANDOFF['RESOLVED-IN-P5-I'].length,15);
});

test('integrated memory semantics depend only on shared x86 contracts, never integer.js/opStr/NoAlias',()=>{
  const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../js/targets/architecture/x86_64/effects');
  const owned=['addressing.js','memory.js','string.js','atomic.js'];
  for(const name of owned){
    const source=fs.readFileSync(path.join(directory,name),'utf8');
    assert.equal(source.includes('opStr'),false,`${name} must not parse opStr`);
    assert.equal(/NoAlias|noAlias/.test(source),false,`${name} must not invent NoAlias`);
  }
  const memory=fs.readFileSync(path.join(directory,'memory.js'),'utf8');
  assert.equal(memory.includes("from './integer.js'"),false,'memory.js must not duplicate/import register-form truth');
  assert.equal(memory.includes("from './scalar.js'"),true,'memory.js must reuse canonical shared scalar helpers');
  assert.equal(memory.includes("from './flags.js'"),true,'memory.js must reuse canonical shared flag helpers');
});
