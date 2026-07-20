# Migration to 0.1.25

Version 0.1.25 adds Kimi model routes through Maestro and hardens session reset around durable
memory archiving.

## Maestro and model routing

- `maestro-agent-sdk` is upgraded to `0.1.46`.
- Maestro supports `kimi-k3` (`kimi`, `kimi-pro`) and `kimi-k2.7-code` (`kimi-code`) through
  `MOONSHOT_API_KEY`, with optional `MOONSHOT_BASE_URL` endpoint override.
- Kimi aliases are normalized before topic config, subagent config, rollout selection, and session
  comparison. Equivalent aliases therefore no longer clear an existing provider session.
- The model picker presents Maestro routes as `kimi-k3`, `kimi-k2.7-code`, then `deepseek-pro`.
  `deepseek-pro` remains the default Maestro model and requires `DEEPSEEK_API_KEY`.
- Retired DeepSeek Flash aliases are rejected; `deepseek-pro` remains supported.

## Session reset

- `/new` resets the current topic session in place while preserving the topic and visible history.
- Reset waits for the durable memory archive before purging provider context, with a bounded
  timeout so a failed archiver cannot hold topic maintenance indefinitely.
- Maintenance ownership is checked again after the archive wait so a superseded process cannot
  purge a newer session.
- Archive settlement errors always notify reset callers and leave the durable job retryable.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.25`.
2. Configure `MOONSHOT_API_KEY` on nodes that will run Kimi; keep `DEEPSEEK_API_KEY` when the
   default `deepseek-pro` route must remain available.
3. Restart every Negotium/Otium node and confirm its daemon reports version `0.1.25`.
4. Verify `/model` shows Kimi K3, Kimi K2.7 Code, and DeepSeek Pro in that order.
5. Run `/new` in a test topic and confirm the next message starts a fresh provider session after
   memory archiving settles.
