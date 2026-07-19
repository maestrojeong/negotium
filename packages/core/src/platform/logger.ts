import pino from "pino";

export interface StdioLoggerOptions {
  level?: string;
  development?: boolean;
}

/**
 * Always write logs to stderr (fd 2), never stdout.
 *
 * MCP servers under `src/mcp/**` run as stdio subprocesses where stdout is the
 * JSON-RPC transport channel. A single log line on stdout corrupts the next
 * message and the MCP client closes the transport ("Transport closed"). The
 * main bot process is also fine with stderr — pm2 captures both streams.
 *
 * In dev mode pino spawns a `pino-pretty` worker that owns its own sink, so we
 * pass `destination: 2` through transport.options. In prod (no transport) the
 * second arg to `pino()` sets the destination directly.
 */
export function createStdioLogger(options: StdioLoggerOptions = {}) {
  const development = options.development ?? process.env.NODE_ENV === "development";
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      transport: development
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
              destination: 2,
            },
          }
        : undefined,
    },
    pino.destination(2),
  );
}

export type StdioLogger = ReturnType<typeof createStdioLogger>;

export const logger = createStdioLogger();
