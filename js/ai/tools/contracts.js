const READ_SCOPES = Object.freeze(["auto", "selection", "function", "neighborhood", "binary", "project", "runtime"]);

export function analysisToolContract(toolRegistry, toolName) {
  const tool = toolRegistry?.get?.(String(toolName));
  if (!tool) {
    throw new Error(`unknown-analysis-tool:${toolName}`);
  }

  const scopeSupport = Object.freeze([...(tool.scopeSupport || [])]);
  return Object.freeze({
    name: String(tool.name),
    scopeSupport,
    mutability: String(tool.mutability || "read-only"),
    needsApproval: Boolean(tool.needsApproval),
    inputSchema: tool.inputSchema,
  });
}

export function auditCapabilityToolContracts({ capabilities = [], toolRegistry } = {}) {
  const rows = [];
  const errors = [];

  for (const cap of capabilities) {
    if (!cap.agentTool) continue;
    const tool = toolRegistry?.get?.(cap.agentTool);
    const rowErrors = [];
    const toolPresent = Boolean(tool);

    if (!toolPresent) {
      rowErrors.push(`missing-tool:${cap.agentTool}`);
    } else {
      if (tool.mutability !== "read-only") {
        rowErrors.push(`analysis-tool-not-read-only:${cap.agentTool}`);
      }
      if (tool.needsApproval) {
        rowErrors.push(`analysis-tool-needs-approval:${cap.agentTool}`);
      }

      const seenScopes = new Set();
      for (const s of tool.scopeSupport || []) {
        if (!READ_SCOPES.includes(s)) {
          rowErrors.push(`invalid-tool-scope:${cap.agentTool}:${s}`);
        }
        if (seenScopes.has(s)) {
          rowErrors.push(`duplicate-tool-scope:${cap.agentTool}:${s}`);
        }
        seenScopes.add(s);
      }
    }

    errors.push(...rowErrors);
    rows.push({
      capabilityId: cap.id,
      agentTool: cap.agentTool,
      toolPresent,
      scopeSupport: tool?.scopeSupport ? [...tool.scopeSupport] : null,
      mutability: tool?.mutability ?? null,
      needsApproval: tool ? Boolean(tool.needsApproval) : null,
      errors: rowErrors,
    });
  }

  return {
    ok: errors.length === 0,
    rows,
    errors,
  };
}
