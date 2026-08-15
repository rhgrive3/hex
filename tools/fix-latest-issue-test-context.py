from pathlib import Path

path = Path('tests/issues-400-405.mjs')
text = path.read_text()
old = """  runtime:null,
  storedValueAliases:new Map(),
});"""
new = """  runtime:null,
  storedValueAliases:new Map(),
  exprCache:new Map(),
  exprActive:new Set(),
  exprNodes:0,
});"""
if text.count(old) != 1:
    raise SystemExit(f'tests/issues-400-405.mjs: expected one context match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
