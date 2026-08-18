from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one post-payload match, got {count}: {old[:180]!r}')
    p.write_text(text.replace(old, new, 1))

# #822 self-review: do not label floating-point compare state as the integer
# NZCV model implemented by this legacy expression layer. Keep unsupported
# producers explicit/unknown instead of attaching a false exact proof marker.
replace_once(
    'js/expr.js',
'''function flagConditionNode(flags, cond) {
  if (!flags || !flags.a || !flags.b || !cond) return null;
  return node('flagcond', {''',
'''function flagConditionNode(flags, cond) {
  if (!flags || !flags.a || !flags.b || !cond) return null;
  if (!['adds','cmn','subs','cmp','negs','ands','tst','bics'].includes(flags.op)) return null;
  return node('flagcond', {''')

# #803 self-review: Arm FNMADD is -(a*b)-c, while FNMSUB is a*b-c.
# The helper computes c + signed(product), then selected forms negate the full
# exact result before the one architectural rounding.
replace_once(
    'js/emu.js',
"      const negateProduct = mn === 'fmsub' || mn === 'fnmadd';",
"      const negateProduct = mn === 'fmsub' || mn === 'fnmsub';")

print('final semantic hardening payload applied')
