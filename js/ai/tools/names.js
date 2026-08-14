// Kept dependency-free so the inference Worker does not bundle browser analysis engines.
export const AI_TOOL_NAMES = Object.freeze([
  'search_functions', 'search_strings', 'get_function', 'get_current_function', 'get_selection_context',
  'get_xrefs', 'get_callers', 'get_callees', 'get_semantic_facts', 'decompile_function', 'get_cfg',
  'find_field_reads', 'find_field_writes', 'find_global_accesses', 'trace_value', 'slice_backward',
  'slice_forward', 'find_thresholds', 'verify_field_update', 'get_related_functions',
  'lookup_known_function', 'lookup_signature', 'compare_functions', 'project_search',
  'get_runtime_observations', 'verify_runtime_hypothesis', 'get_binary_diff',
]);
