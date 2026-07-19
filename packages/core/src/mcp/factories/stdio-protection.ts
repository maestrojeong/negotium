export interface McpStdioProtectionTarget {
  env: Record<string, string | undefined>;
  console: Pick<Console, "log" | "info" | "error">;
}

/**
 * Redirect incidental console stdout calls while a stdio MCP entrypoint is active.
 * The caller owns the returned restore function; embedded servers should normally
 * avoid process-wide protection and use an isolated transport instead.
 */
export function protectMcpStdio(target: McpStdioProtectionTarget): () => void {
  target.env.MAESTRO_SDK_SILENT_BOOTSTRAP ??= "1";
  const originalLog = target.console.log;
  const originalInfo = target.console.info;
  let active = true;
  target.console.log = (...args: unknown[]) => target.console.error(...args);
  target.console.info = (...args: unknown[]) => target.console.error(...args);
  return () => {
    if (!active) return;
    active = false;
    target.console.log = originalLog;
    target.console.info = originalInfo;
  };
}
