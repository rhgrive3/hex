from pathlib import Path

p=Path('tests/run.js')
text=p.read_text()
block="""
test('IL2CPP: #496 binding trust regressions stay fail-closed', async () => {
  await import('./issue-496-il2cpp-binding.mjs');
});

"""
marker='await Promise.all(pending);'
if block not in text:
    if marker not in text: raise SystemExit('test runner finalization anchor not found')
    text=text.replace(marker,block+marker,1)
p.write_text(text)
