from pathlib import Path

p=Path('js/recognition/matcher.js')
text=p.read_text()
start_marker='// Candidates above the recognition threshold form small bipartite ambiguity\n'
end_marker='export function maximumWeightCandidateMatching(candidates = [], options = {}) {'
if start_marker in text:
    start=text.index(start_marker)
    end=text.index(end_marker,start)
    text=text[:start]+"// Exact ambiguity solving is implemented only in bounded-matching.js.\n"+text[end:]
p.write_text(text)
