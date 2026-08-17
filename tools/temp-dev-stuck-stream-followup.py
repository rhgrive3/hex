from pathlib import Path

path = Path('js/userscript/chatgpt-adapter.js')
text = path.read_text()
old = '''              if (!structuredStopIssued) {
                structuredStopIssued = this.stopOwnedGeneration({
                  requestUserTurn,
                  normalizedPrompt,
                  observedConversation,
                });
              }
'''
new = '''              if (!structuredStopIssued) {
                structuredStopIssued = this.stopOwnedGeneration({
                  requestUserTurn,
                  normalizedPrompt,
                  observedConversation,
                });
              }
              // stopOwnedGeneration() synchronously changes the DOM in the real
              // ChatGPT surface. Never fall through to the ordinary free-text
              // settled path in this same poll, or cursor residue (for example
              // the observed trailing "_") can win before the next structured
              // poll returns the parsed object.
              if (structuredStopIssued) {
                await delay(this.pollMs, signal);
                continue;
              }
'''
count = text.count(old)
print(f'structured-stop-fallthrough: {count}')
if count != 1:
    raise SystemExit(f'expected exactly one generated structured stop block, found {count}')
path.write_text(text.replace(old, new, 1))
