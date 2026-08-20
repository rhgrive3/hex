// Kept dependency-free so the inference Worker does not bundle browser analysis engines.
export const AI_TOOL_NAMES = Object.freeze([
  'search_functions', 'search_strings', 'resolve_objc_dispatch', 'get_function', 'get_current_function', 'get_selection_context',
  'inspect_function_region', 'get_xrefs', 'get_callers', 'get_callees', 'get_semantic_facts',
  'decompile_function', 'get_cfg', 'find_field_reads', 'find_field_writes', 'find_global_accesses',
  'trace_value', 'slice_backward', 'slice_forward', 'find_thresholds', 'verify_field_update',
  'get_related_functions', 'find_constant', 'find_paths', 'explain_evidence', 'symbolic_execute',
  'lookup_known_function', 'lookup_signature', 'compare_functions', 'project_search',
  'get_observation_detail', 'get_evidence_detail',
  'get_runtime_observations', 'verify_runtime_hypothesis', 'get_binary_diff',
  'verify_edge_feasibility', 'verify_bounded_equivalence', 'verify_patch_equivalence',
]);
