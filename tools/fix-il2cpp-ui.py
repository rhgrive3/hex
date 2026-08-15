from pathlib import Path
p=Path('js/tools.js')
s=p.read_text()
s=s.replace("import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses } from './il2cpp.js';","import { parseMetadataAuto, looksLikeUnity, bindMethodAddresses, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';")
needle="""      const f = picker.files && picker.files[0];
      if (!f) return;
      body.replaceChildren(el('div', 'hint', '読み込んでいます…'));
      try {
        const meta = parseMetadataAuto(await f.arrayBuffer());
        await bindMethodAddresses(meta, {
          regions: app.store.get('regions') || [],
          read: (addr, len) => app.backend.readAt(addr, len)
            .then((r) => (r && r.found ? r.bytes : null)),
        });"""
repl="""      const f = picker.files && picker.files[0];
      if (!f) return;
      if (f.size > MAX_IL2CPP_METADATA_BYTES) {
        body.replaceChildren(el('div', 'hint', `global-metadata.dat が大きすぎます (${Math.ceil(f.size/1024/1024)} MiB)。安全上 ${MAX_IL2CPP_METADATA_BYTES/1024/1024} MiB までです。`));
        return;
      }
      const controller = new AbortController();
      body.replaceChildren(el('div', 'hint', '読み込んでいます…'));
      try {
        const meta = parseMetadataAuto(await f.arrayBuffer(), { signal:controller.signal });
        await bindMethodAddresses(meta, {
          regions: app.store.get('regions') || [], signal:controller.signal,
          read: (addr, len) => app.backend.readAt(addr, len)
            .then((r) => (r && r.found ? r.bytes : null)),
        });"""
if needle not in s: raise SystemExit('actual IL2CPP picker anchor missing')
s=s.replace(needle,repl,1)
p.write_text(s)
