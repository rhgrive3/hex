from pathlib import Path
for name in ['js/tools.js','js/ai/ui/hex-context.js']:
    p=Path(name); text=p.read_text()
    text=text.replace("    appleRuntime: app.objcModel ? { runtime:'mixed', objc:app.objcModel, objcIndex:app.objcRuntime || app.objcModel.runtimeIndex || null, swift:null } : null,\n","")
    p.write_text(text)
