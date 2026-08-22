const WINDOWS = Object.freeze({
  current: ['get_current_function','get_selection_context','get_semantic_facts','trace_value','get_cfg','get_callers','get_callees','lookup_signature','search_functions'],
  discovery: ['search_functions','search_strings','lookup_known_function','lookup_signature','get_function','get_semantic_facts','get_callers','get_callees','get_related_functions'],
  verification: ['verify_field_update','get_semantic_facts','trace_value','slice_backward','get_cfg','get_runtime_observations','verify_runtime_hypothesis','get_function'],
  project: ['project_search','get_binary_diff','compare_functions','lookup_known_function','lookup_signature','get_function'],
  runtime: ['get_runtime_observations','verify_runtime_hypothesis','get_current_function','get_semantic_facts','trace_value'],
});
const AUTO_ESCAPE_TOOLS = Object.freeze(['search_functions']);
const KNOWN_WINDOW_TOOLS = new Set(Object.values(WINDOWS).flat());

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
  const requestedLimit = Number(maxTools);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.max(1, Math.floor(requestedLimit)) : 1;
  const selected = [];

  // Reserve continuity before any phase/novel filling. A phase transition must
  // not invalidate the immediately previous scope-valid tool; otherwise the
  // runtime cannot reach its deterministic repeated-call guard and reports an
  // artificial invalid_tool_call instead.
  const previousTool = previousToolName(observations);
  if (previousTool && byName.has(previousTool)) selected.push(byName.get(previousTool));

  // Auto escape is a control-plane liveness guarantee, not an ordinary phase
  // preference. Reserve it before novel/filler slots so future-tool rotation
  // can never push the only legal path to wider evidence out of the window.
  if (requestedScope === 'auto') {
    for (const name of AUTO_ESCAPE_TOOLS) {
      if (byName.has(name) && !selected.some((item) => item.name === name) && selected.length < limit) selected.push(byName.get(name));
    }
  }

  // ToolRegistry is allowed to grow independently of this control plane. Keep
  // a small rotating slot for scope-valid definitions not known when this file
  // was written. This is metadata-driven (already filtered by effectiveScope),
  // not a keyword guess, and guarantees new read tools do not become permanently
  // unreachable merely because their names are absent from the phase buckets.
  const novel = available.filter((tool) => !KNOWN_WINDOW_TOOLS.has(tool.name) && !AUTO_ESCAPE_TOOLS.includes(tool.name));
  const novelSlots = novel.length ? (limit >= 4 ? Math.min(2, Math.max(0, limit - 2)) : (observations.length % 2 ? 1 : 0)) : 0;
  const preferredLimit = Math.max(selected.length, limit - novelSlots);
  for (const name of preferred) {
    if (byName.has(name) && !selected.some((item) => item.name === name) && selected.length < preferredLimit) selected.push(byName.get(name));
  }
  addRotating(selected, novel, novelSlots, observations.length, limit);

  // Fill any remaining capacity from the scope-valid registry. This preserves
  // useful legacy behavior while avoiding a hard dependency on static names.
  for (const tool of available) {
    if (!selected.some((item) => item.name === tool.name) && selected.length < limit) selected.push(tool);
  }
  return { phase, tools: selected.slice(0, limit) };
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

function addRotating(selected, tools, count, offset, limit) {
  if (!count || !tools.length) return;
  const start = Math.max(0, Number(offset) || 0) % tools.length;
  for (let index = 0; index < tools.length && count > 0 && selected.length < limit; index++) {
    const tool = tools[(start + index) % tools.length];
    if (selected.some((item) => item.name === tool.name)) continue;
    selected.push(tool);
    count--;
  }
}

function previousToolName(observations) {
  for (let index = observations.length - 1; index >= 0; index--) {
    const name = observations[index]?.tool;
    if (name && name !== 'deterministic_goal_planner' && name !== 'protocol_guardrail') return name;
  }
  return null;
}
