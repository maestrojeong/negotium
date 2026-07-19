# Migration to 0.1.23

Version 0.1.23 closes a Vault substitution boundary issue introduced in 0.1.20.

## Vault tool-input allowlist

- Claude and Maestro now resolve `{{KEY}}` only for browser tools and the explicit transient
  execution tools `Bash` and `WebFetch`.
- Session communication, task, wiki, logging, and file-persistence tools retain placeholders
  verbatim. This prevents credentials from being written into messages, tasks, archives, or logs.
- The policy is default-deny, so unknown and newly added tools do not receive plaintext Vault
  values unless they are explicitly reviewed and allowlisted.
- Tool outputs continue to be redacted, and direct runtime secret-storage access remains blocked.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.23`.
2. Restart every Negotium/Otium node so provider hooks reload the new policy.
3. Verify a `tell_session` call containing a test Vault placeholder delivers the placeholder, not
   its stored value.
4. Audit and rotate credentials that may have been used in messaging or persistence tools while
   running versions 0.1.20 through 0.1.22. Archive cleanup should be reviewed separately before
   deleting or rewriting historical data.
