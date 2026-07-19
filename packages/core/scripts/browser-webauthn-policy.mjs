const NO_BROWSER_START_TOOLS = new Set(["browser_status", "browser_close"]);

/**
 * Install Patchright's virtual authenticator before a page can invoke WebAuthn.
 * This prevents Chrome's native passkey chooser from invisibly blocking DOM tools.
 */
export function createBrowserWebAuthnGuard() {
  const installedContexts = new WeakSet();

  async function ensureInstalled(manager) {
    const page = await manager.getPage();
    const context = page.context();
    if (installedContexts.has(context)) return false;
    await context.credentials.install();
    installedContexts.add(context);
    return true;
  }

  return {
    async beforeTool(toolName, manager) {
      if (
        NO_BROWSER_START_TOOLS.has(toolName) ||
        toolName === "browser_start" ||
        toolName === "browser_passkey_install"
      )
        return;
      await ensureInstalled(manager);
    },
    async afterTool(toolName, manager) {
      if (toolName === "browser_start") await ensureInstalled(manager);
      if (toolName === "browser_passkey_install") {
        const page = await manager.getPage();
        installedContexts.add(page.context());
      }
    },
  };
}
