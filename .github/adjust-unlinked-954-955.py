from pathlib import Path

path = Path('js/targets/abi/registry.js')
text = path.read_text()
old = "if (id === 'ms-x64' || id === 'msvc-x64' || id === 'x64') return 'microsoft-x64';"
new = "if (id === 'win64' || id === 'ms-x64' || id === 'msvc-x64' || id === 'x64') return 'microsoft-x64';"
if text.count(old) != 1:
    raise SystemExit(f'#954 Win64 alias anchor expected once, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
