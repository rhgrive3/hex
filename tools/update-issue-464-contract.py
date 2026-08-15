from pathlib import Path

p = Path('tests/run.js')
text = p.read_text()

old = """  eq(idx.isFunctionStart(0x200n), true);\n  eq(idx.functionAt(0x204n).start, 0x200n);\n  eq(idx.addNames([]), 0);\n"""
new = """  eq(idx.isFunctionStart(0x200n), true);\n  eq(idx.functionAt(0x200n).start, 0x200n, 'exact function starts remain identifiable');\n  eq(idx.functionAt(0x204n), null, 'unknown last-function extent must not absorb trailing bytes');\n  eq(idx.addNames([]), 0);\n"""
if new not in text:
    if old not in text:
        raise SystemExit('symbol contract anchor not found')
    text = text.replace(old, new, 1)

old = """  eq(users[0].addr, PC);\n  eq(users[1].addr, PC + 0x40n);\n  eq(p.refsFrom(PC, PC + 0x40n).length, 1, 'この関数が指しているデータ');\n"""
new = """  eq(users[0].addr, PC);\n  eq(users[1].addr, null, 'end不明の最後の関数へ参照siteを誤帰属しない');\n  eq(users[1].site, PC + 0x50n, '関数帰属が不明でも参照site自体は失わない');\n  eq(p.refsFrom(PC, PC + 0x40n).length, 1, 'この関数が指しているデータ');\n"""
if new not in text:
    if old not in text:
        raise SystemExit('program contract anchor not found')
    text = text.replace(old, new, 1)

p.write_text(text)
