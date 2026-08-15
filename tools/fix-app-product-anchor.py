from pathlib import Path
p=Path('tools/fix-app-product-529-531-541-543-544-545-546.py')
s=p.read_text()
s=s.replace("start=s.index('    async searchFunctions(')", "start=s.index('    searchFunctions(')")
s=s.replace("end=s.index('\\n    async searchStrings(',start)", "end=s.index('\\n    async decompile(',start)")
s=s.replace("import { buildObjcModel, buildObjcRuntimeIndex } from './objc.js';", "import { buildObjcModel, buildObjcRuntimeModel, buildObjcRuntimeIndex } from './objc.js';")
s=s.replace("const model = list ? await buildObjcModel(read, list, null, imageBase, { protocolList, categoryList, sections:{protocolList,categoryList} })", "const model = list ? await buildObjcRuntimeModel(read, list, null, imageBase, { protocolList, categoryList, sections:{protocolList,categoryList} })")
p.write_text(s)
