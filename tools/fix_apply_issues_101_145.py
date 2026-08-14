from pathlib import Path
p = Path('tools/apply_issues_101_145.py')
s = p.read_text()
old = '''replace('js/cfg.js',
        "          node.succ.push({ to: -1, kind: EDGE.JUMP, target, address: inst.address, outside: true });\\n          node.isExit = true;",
        "          node.succ.push({ to: -1, kind: isUncond ? EDGE.JUMP : EDGE.TAKEN, target, address: inst.address, outside: true, conditional: !isUncond });\\n          node.isExit = !!isUncond;",
        '#132 external conditional edge')'''
new = '''replace('js/cfg.js',
        "        node.succ.push({ to: -1, kind: EDGE.JUMP, target: term.branchTarget, outside: true });\\n        node.isExit = true;",
        "        node.succ.push({ to: -1, kind: isUncond ? EDGE.JUMP : EDGE.TAKEN, target: term.branchTarget, outside: true, conditional: !isUncond });\\n        node.isExit = !!isUncond;",
        '#132 external conditional edge')'''
if old not in s:
    raise SystemExit('cfg #132 applicator pattern not found')
s = s.replace(old, new, 1)
old = '''sub('js/cfg.js', r'function blockAtRow\\(blocks, row\\) \\{.*?\\n\\}', r''' + "'''" + '''function blockAtRow(blocks, row) {
  let lo = 0, hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, b = blocks[mid];
    if (row < b.startRow) hi = mid - 1;
    else if (row > b.endRow) lo = mid + 1;
    else return b.index;
  }
  return -1;
}''' + "'''" + ''', label='#134 blockAtRow binary search')'''
new = '''sub('js/cfg.js', r'  const blockAtRow = \\(row\\) => \\{.*?\\n  \\};', r''' + "'''" + '''  const blockAtRow = (row) => {
    let lo = 0, hi = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, b = blocks[mid];
      if (row < b.startRow) hi = mid - 1;
      else if (row > b.endRow) lo = mid + 1;
      else return mid;
    }
    return -1;
  };''' + "'''" + ''', label='#134 blockAtRow binary search')'''
if old not in s:
    raise SystemExit('cfg #134 applicator pattern not found')
s = s.replace(old, new, 1)
p.write_text(s)
