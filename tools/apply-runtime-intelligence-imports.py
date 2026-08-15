from pathlib import Path
p=Path('js/app.js')
s=p.read_text()
old="import { buildObjcRuntimeModel } from './objc.js';"
new="""import { buildObjcRuntimeModel, buildObjcRuntimeIndex } from './objc.js';
import { buildSwiftMetadataModel, buildSwiftRuntimeIndex, resolveSwiftDispatch } from './swift.js';
import { rankApplicationFunctions } from './recognition/classifier.js';
import { KnowledgeDB } from './knowledge/index.js';"""
if old not in s: raise SystemExit('runtime import anchor missing')
p.write_text(s.replace(old,new,1))
