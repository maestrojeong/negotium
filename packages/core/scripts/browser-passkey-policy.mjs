const PASSKEY_RESULT_TOOLS = new Set(["browser_passkey_create", "browser_passkey_list"]);

/** Hide private-key export switches from the tool catalog shown to agents. */
export function secureBrowserToolCatalog(tools) {
  return tools.map((tool) => {
    if (!PASSKEY_RESULT_TOOLS.has(tool.name)) return tool;
    const clone = structuredClone(tool);
    if (clone.inputSchema?.properties) delete clone.inputSchema.properties.includePrivateKey;
    clone.description = clone.description.replace(
      /\s*Private keys are omitted unless includePrivateKey=true\.?/,
      " Private keys are never returned to the agent.",
    );
    return clone;
  });
}

/**
 * Enforce gateway-owned fields even if a model sends out-of-schema input.
 * Both claim and release stay pinned to the authenticated gateway owner as
 * defense in depth, even when the selected backend also enforces owner scope.
 */
export function secureBrowserToolInput(toolName, input, owner) {
  if (!input || typeof input !== "object") return input;
  let secured = input;
  if (owner && (toolName === "browser_claim_page" || toolName === "browser_release_page")) {
    secured = { ...secured, owner };
  }
  if (PASSKEY_RESULT_TOOLS.has(toolName)) {
    secured = { ...secured, includePrivateKey: false };
  }
  return secured;
}

/** Defense in depth if an upstream handler ever returns passkey key material unexpectedly. */
export function secureBrowserToolOutput(toolName, output) {
  if (!PASSKEY_RESULT_TOOLS.has(toolName)) return output;
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "privateKey")
        .map(([key, nested]) => [key, visit(nested)]),
    );
  };
  return visit(output);
}
