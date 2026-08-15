from pathlib import Path

p=Path('js/recognition/matcher.js')
text=p.read_text()
old="""  const eligibleByBefore = new Map();
  for (const c of eligible) { let list=eligibleByBefore.get(c.i); if (!list) eligibleByBefore.set(c.i,list=[]); list.push(c); }
  for (const list of eligibleByBefore.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.j-b.j);
"""
new="""  const eligibleByBefore = new Map(), eligibleByAfter = new Map();
  for (const c of eligible) {
    let left=eligibleByBefore.get(c.i); if (!left) eligibleByBefore.set(c.i,left=[]); left.push(c);
    let right=eligibleByAfter.get(c.j); if (!right) eligibleByAfter.set(c.j,right=[]); right.push(c);
  }
  for (const list of eligibleByBefore.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.j-b.j);
  for (const list of eligibleByAfter.values()) list.sort((a,b)=>b.confidence-a.confidence || b.baseConfidence-a.baseConfidence || a.i-b.i);
"""
if new not in text:
    if old not in text: raise SystemExit('eligible ambiguity map anchor not found')
    text=text.replace(old,new,1)
old="""    const alternatives = (eligibleByBefore.get(c.i) || []).filter((x) => x.j !== c.j && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ index: x.j, address: after[x.j].address, confidence: x.confidence, identity: x.identity, reasons: x.reasons }));
    const ambiguous = alternatives.length > 0;
"""
new="""    const forwardAlternatives = (eligibleByBefore.get(c.i) || []).filter((x) => x.j !== c.j && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ side:'after', index:x.j, address:after[x.j].address, confidence:x.confidence, identity:x.identity, reasons:x.reasons }));
    const reverseAlternatives = (eligibleByAfter.get(c.j) || []).filter((x) => x.i !== c.i && x.confidence >= c.confidence - ambiguityWindow)
      .slice(0, 4).map((x) => ({ side:'before', index:x.i, address:before[x.i].address, confidence:x.confidence, identity:x.identity, reasons:x.reasons }));
    const alternatives = [...forwardAlternatives, ...reverseAlternatives]
      .sort((a,b)=>b.confidence-a.confidence || String(a.side).localeCompare(String(b.side)) || a.index-b.index).slice(0, 4);
    const ambiguous = alternatives.length > 0;
"""
if new not in text:
    if old not in text: raise SystemExit('reverse ambiguity anchor not found')
    text=text.replace(old,new,1)
p.write_text(text)
