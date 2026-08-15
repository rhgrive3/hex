const WINDOWS = Object.freeze({
  current: ['get_current_function','get_selection_context','get_semantic_facts','trace_value','get_cfg','get_callers','get_callees','lookup_signature','search_functions'],
  discovery: ['search_functions','search_strings','lookup_known_function','lookup_signature','get_function','get_semantic_facts','get_callers','get_callees','get_related_functions'],
  verification: ['verify_field_update','get_semantic_facts','trace_value','slice_backward','get_cfg','get_runtime_observations','verify_runtime_hypothesis','get_function'],
  project: ['project_search','get_binary_diff','compare_functions','lookup_known_function','lookup_signature','get_function'],
  runtime: ['get_runtime_observations','verify_runtime_hypothesis','get_current_function','get_semantic_facts','trace_value'],
});
const AUTO_ESCAPE_TOOLS = Object.freeze(['search_functions']);

export function selectToolWindow(registry, { mode = 'agent', requestedScope = 'auto', effectiveScope = 'function', intent = 'unknown', observations = [], hypotheses = [], maxTools = 10 } = {}) {
  let available = registry.definitionsForModel({ scope: effectiveScope });
  if (requestedScope === 'auto') {
    // Auto may expose a tiny, deliberate escape hatch from the wider registry
    // so the model can request evidence that triggers controlled expansion.
    // Everything else must already be valid in the current effective scope.
    const effectiveNames = new Set(available.map((tool) => tool.name));
    const wider = registry.definitionsForModel({ scope: 'auto' });
    for (const tool of wider) {
      if (AUTO_ESCAPE_TOOLS.includes(tool.name) && !effectiveNames.has(tool.name)) {
        available.push(tool);
        effectiveNames.add(tool.name);
      }
    }
  }
  const phase = choosePhase({ intent, observations, hypotheses, effectiveScope });
  const preferred = WINDOWS[phase] || WINDOWS.current;
  const byName = new Map(available.map((tool) => [tool.name, tool]));
  const selected = [];
  for (const name of preferred) if (byName.has(name) && selected.length < maxTools) selected.push(byName.get(name));
  if (selected.length < Math.min(5, maxTools)) {
    for (const tool of available) if (!selected.some((item) => item.name === tool.name) && selected.length < maxTools) selected.push(tool);
  }
  return { phase, tools: selected.slice(0, Math.max(1, maxTools)) };
}

export function choosePhase({ intent, observations = [], hypotheses = [], effectiveScope } = {}) {
  if (effectiveScope === 'runtime' || intent === 'runtime-verify') return 'runtime';
  if (effectiveScope === 'project' || intent === 'project-query' || intent === 'compare') return 'project';
  const missingEvidence = hypotheses.some((item) => Array.isArray(item?.missingEvidence) && item.missingEvidence.length);
  const hasCandidate = observations.some((item) => ['search_functions','search_strings','deterministic_goal_planner'].includes(item.tool));
  if (missingEvidence || (hasCandidate && observations.length > 1)) return 'verification';
  if (intent === 'find-behaviour' || intent === 'find-function' || effectiveScope === 'binary') return 'discovery';
  return 'current';
}
