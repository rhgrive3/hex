/* QueryAPI completeness facade for the AI tool registry. */
export { ToolRegistry } from './registry-query-base.js';

import { createHexToolRegistry as createBaseHexToolRegistry } from './registry-query-base.js';

function addressText(value) {
  if (value == null) return null;
  try { return `0x${BigInt(value).toString(16)}`; } catch { return String(value); }
}
function replace(registry, name, execute) {
  const current = registry.get(name);
  if (!current) return;
  registry.tools.set(name, Object.freeze({ ...current, execute }));
}

export function createHexToolRegistry(context = {}, options = {}) {
  const registry = createBaseHexToolRegistry(context, options);
  if (context?.analysisAuthority !== 'AnalysisQueryAPI') return registry;

  if (typeof context.getDecompile === 'function') {
    replace(registry, 'decompile_function', async ({ functionAddress }) => {
      const value = await context.getDecompile(functionAddress, { signal:registry.executionSignal });
      const text = typeof value?.text === 'string' ? value.text : '';
      const preview = text.slice(0, 30000);
      const previewTruncated = text.length > preview.length;
      const complete = value?.complete === true && !previewTruncated;
      return {
        functionAddress:addressText(functionAddress),
        pseudocodeExcerpt:preview,
        total:text.length,
        returned:preview.length,
        complete,
        truncated:!complete,
        unsupported:value?.unsupported === true,
        reason:complete ? null : (previewTruncated ? 'preview-limit' : (value?.reason || 'decompile-incomplete')),
        trust:'untrusted-data',
        analysisAuthority:'AnalysisQueryAPI',
      };
    });
  }

  return registry;
}

export default createHexToolRegistry;
