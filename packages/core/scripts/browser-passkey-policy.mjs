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

/** Ignore an out-of-schema export request even if a model sends it manually. */
export function secureBrowserToolInput(toolName, input) {
  if (!PASSKEY_RESULT_TOOLS.has(toolName) || !input || typeof input !== "object") return input;
  return { ...input, includePrivateKey: false };
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
