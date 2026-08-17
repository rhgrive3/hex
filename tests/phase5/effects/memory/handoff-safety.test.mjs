import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const P5_1_MEMORY_FORM_HANDOFF=Object.freeze({'IMPLEMENTED-IN-P5-2':Object.freeze(['ADD','SUB','CMP','TEST','AND','OR','XOR','NOT','SETcc','CMOVcc']),'P5-I-INTEGRATION-REQUIRED':Object.freeze(['ADC','SBB','INC','DEC','NEG','SHL','SAL','SHR','SAR','ROL','ROR','IMUL','MUL','DIV','IDIV']),'OUTSIDE-MANDATORY-CORPUS':Object.freeze([])});
test('P5-1 overlapping memory families are explicitly classified',()=>{const all=Object.values(P5_1_MEMORY_FORM_HANDOFF).flat(),required=['ADD','SUB','CMP','TEST','ADC','SBB','INC','DEC','NEG','SHL','SAL','SHR','SAR','ROL','ROR','IMUL','MUL','DIV','IDIV','SETcc','CMOVcc'];assert.deepEqual([...new Set(all)].sort(),[...required].sort());});
test('P5-2 production code has no opStr semantic parser, NoAlias claim, or P5-1-only helper dependency',()=>{const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../js/targets/architecture/x86_64/effects'),owned=['addressing.js','memory.js','string.js','atomic.js'],forbidden=['emitX86IncDecFlags','emitX86NegFlags','emitX86ShiftFlags','emitX86RotateFlags','emitX86MultiplyFlags','emitX86DivisionUndefinedFlags'];for(const name of owned){const source=fs.readFileSync(path.join(directory,name),'utf8');assert.equal(source.includes('opStr'),false);assert.equal(/NoAlias|noAlias/.test(source),false);for(const symbol of forbidden)assert.equal(source.includes(symbol),false,`${name} must not depend on ${symbol}`);}});
