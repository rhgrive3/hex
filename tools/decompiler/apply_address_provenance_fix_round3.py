from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / "js/decompiler/semantic.js"
text = path.read_text()
before = '''  } else if (d.op === OP.LOAD) {\n    parts.push(dependencySource(d.addr?.base, ctx, seen, depth + 1));\n    parts.push(dependencySource(d.addr?.index, ctx, seen, depth + 1));\n  } else {\n'''
after = '''  } else if (d.op === OP.LOAD) {\n    // A fixed stack slot's SP/FP arithmetic is frame-construction provenance,\n    // not source provenance for the value loaded from that slot. Including it\n    // makes unrelated prologue instructions (for example 0x...490 STP) appear\n    // to own later C statements. Keep the load itself, but stop at the stack\n    // memory boundary. Non-stack addressing still retains its base/index defs.\n    if (d.loc?.kind !== MK.STACK) {\n      parts.push(dependencySource(d.addr?.base, ctx, seen, depth + 1));\n      parts.push(dependencySource(d.addr?.index, ctx, seen, depth + 1));\n    }\n  } else {\n'''
count = text.count(before)
if count != 1:
    raise SystemExit(f"stack-load provenance: expected one match, found {count}")
path.write_text(text.replace(before, after, 1))
print("round3 provenance boundary fix applied")
