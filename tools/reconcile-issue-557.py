from pathlib import Path
p = Path('tests/runtime-platform.mjs')
text = p.read_text()
if "const approx557" not in text:
    text = text.replace("  const runtimeCases = (status, count) => Array.from({ length: count }, () => ({ comparison: { status } }));\n", "  const approx557 = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);\n  const runtimeCases = (status, count) => Array.from({ length: count }, () => ({ comparison: { status } }));\n", 1)
text = text.replace("assert.equal(supported1.status, 'supported'); assert.equal(supported1.confidence, 0.60);", "assert.equal(supported1.status, 'supported'); approx557(supported1.confidence, 0.60);")
text = text.replace("assert.equal(supported2.status, 'supported'); assert.equal(supported2.confidence, 0.65);", "assert.equal(supported2.status, 'supported'); approx557(supported2.confidence, 0.65);")
text = text.replace("assert.equal(confirmed3.status, 'confirmed'); assert.equal(confirmed3.confidence, 0.87);", "assert.equal(confirmed3.status, 'confirmed'); approx557(confirmed3.confidence, 0.87);")
text = text.replace("assert.equal(twoWithStatic.confidence, supported2.confidence, 'static evidence must not lift a supported verdict above its source confidence');", "approx557(twoWithStatic.confidence, supported2.confidence); // static evidence must not exceed runtime-supported source confidence")
text = text.replace("assert.equal(confirmed.confidence, confirmed3.confidence);", "approx557(confirmed.confidence, confirmed3.confidence);")
p.write_text(text)
