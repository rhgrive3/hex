from pathlib import Path

p=Path('js/objc.js')
text=p.read_text()
text=text.replace("""import {
  buildObjcModel as buildLegacyObjcModel,
  buildObjcNames,
  objcTypeHints,
  parseObjcMethod,
  selectorFromCall,
} from './objc-legacy.js';
""","import { buildObjcModel as buildLegacyObjcModel } from './objc-legacy.js';\n")
text=text.replace("""
export {
  buildObjcNames,
  objcTypeHints,
  parseObjcMethod,
  selectorFromCall,
};
""","\n")
p.write_text(text)

for name in ['js/tools.js','js/ai/ui/hex-context.js']:
    p=Path(name); text=p.read_text()
    text=text.replace("    appleRuntime: app.objcModel ? { runtime:'mixed', objc:app.objcModel, objcIndex:app.objcRuntime || app.objcModel.runtimeIndex || null, swift:null } : null,\n","")
    p.write_text(text)
