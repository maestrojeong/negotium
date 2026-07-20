# Migration to 0.1.26

Version 0.1.26 makes headed browser automation work on displayless Linux nodes by launching the
managed Playwright MCP inside an automatically allocated Xvfb display.

## Linux headed browser launch

- macOS keeps the existing direct process spawn.
- Linux with `DISPLAY` or `WAYLAND_DISPLAY` keeps the existing direct process spawn.
- Linux without either display variable wraps the exact browser MCP command and argv in
  `xvfb-run -a -s "-screen 0 1440x1000x24"` without invoking a shell.
- A displayless Linux node without `xvfb-run` now fails immediately with an installation error
  instead of silently changing the browser to headless mode.
- Browser profile ownership, ports, restart behavior, and process-tree cleanup remain unchanged.

## Upgrade checklist

1. Install Xvfb on displayless Linux workers (for Ubuntu/Debian: `sudo apt-get install xvfb`).
2. Upgrade the runtime and adapter SDK together to `0.1.26`.
3. Restart every Negotium/Otium worker and confirm its daemon reports version `0.1.26`.
4. Invoke a browser tool and confirm the runtime logs `virtualDisplay: true` on displayless Linux,
   or `virtualDisplay: false` on macOS and Linux desktops with an existing display.
