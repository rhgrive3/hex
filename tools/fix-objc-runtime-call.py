from pathlib import Path
p=Path('tools/fix-app-product-529-531-541-543-544-545-546.py')
s=p.read_text()
s=s.replace("import { buildObjcModel, buildObjcRuntimeIndex } from './objc.js';", "import { buildObjcRuntimeModel, buildObjcRuntimeIndex } from './objc.js';")
s=s.replace("const model = list ? await buildObjcModel(read, list, null, imageBase, { protocolList, categoryList, sections:{protocolList,categoryList} })", "const model = list ? await buildObjcRuntimeModel(read, list, { protocolList, categoryList }, null, imageBase)")
p.write_text(s)
