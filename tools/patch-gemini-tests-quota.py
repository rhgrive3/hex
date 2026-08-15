from pathlib import Path

p = Path('tests/gemini.mjs')
s = p.read_text()
helper = """
let quotaTokenSerial = 0;
const ALLOW_QUOTA = {
  getByName() {
    return {
      async acquire() { return { allowed: true, token: `gemini-test-${++quotaTokenSerial}` }; },
      async release() { return { released: true }; },
    };
  },
};
const quotaEnv = (extra = {}) => ({ ...extra, AI_QUOTA: ALLOW_QUOTA });
"""
anchor = "import { buildGeminiPayload, streamGemini } from '../js/gemini.js';\n"
if 'const ALLOW_QUOTA' not in s:
    if anchor not in s:
        raise SystemExit('gemini test import anchor missing')
    s = s.replace(anchor, anchor + helper, 1)
old = "{ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } }"
new = "quotaEnv({ GEMINI_API_KEY: 'not-exposed', ASSETS: { fetch: () => new Response('asset') } })"
count = s.count(old)
if count:
    s = s.replace(old, new)
if 'quotaEnv({ GEMINI_API_KEY' not in s:
    raise SystemExit('no quota-enabled worker test environments found')
p.write_text(s)
