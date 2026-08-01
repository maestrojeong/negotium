import { expect, test } from "bun:test";
import {
  installTerminalRestore,
  TerminalAlreadyOwnedError,
  terminalRestoreInstalled,
} from "@/terminal-restore";

const SEQUENCE = "<restore>";

const HOOKED_EVENTS = [
  "exit",
  "uncaughtExceptionMonitor",
  "unhandledRejection",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
] as const;

type HookedEvent = (typeof HOOKED_EVENTS)[number];
type Listener = (...args: unknown[]) => void;

function snapshot(): Map<HookedEvent, Set<Listener>> {
  return new Map(
    HOOKED_EVENTS.map((event) => [
      event,
      new Set(process.listeners(event as "exit") as unknown as Listener[]),
    ]),
  );
}

interface Harness {
  writes: string[];
  errors: string[];
  exits: number[];
  log: string[];
  /**
   * Invokes only the listeners this install added. Delivering a real signal
   * would take the test runner down with it, and firing every registered
   * listener would drag in unrelated handlers bun installs.
   */
  emit: (event: HookedEvent, ...args: unknown[]) => void;
}

function install(
  sequence = SEQUENCE,
  onSignal?: (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => void,
  write?: (value: string) => number | undefined,
): { dispose: () => void; harness: Harness } {
  const before = snapshot();
  const writes: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const log: string[] = [];
  const dispose = installTerminalRestore(sequence, {
    onSignal,
    // `writes`/`log` record every *attempt*; the injected writer decides whether
    // it succeeds, short-writes (by returning a byte count) or throws.
    write: (value) => {
      writes.push(value);
      log.push(`write:${value}`);
      return write?.(value);
    },
    writeError: (value) => {
      errors.push(value);
      log.push("stderr");
    },
    exit: (code) => {
      exits.push(code);
      log.push(`exit:${code}`);
    },
  });
  const after = snapshot();
  const added = new Map<HookedEvent, Listener[]>(
    HOOKED_EVENTS.map((event) => [
      event,
      [...(after.get(event) ?? [])].filter((listener) => !before.get(event)?.has(listener)),
    ]),
  );
  return {
    dispose,
    harness: {
      writes,
      errors,
      exits,
      log,
      emit: (event, ...args) => {
        // Re-check registration every time: once the disposer has detached a
        // handler the event must reach nothing at all.
        const live = new Set(process.listeners(event as "exit") as unknown as Listener[]);
        for (const listener of added.get(event) ?? []) {
          if (live.has(listener)) listener(...args);
        }
      },
    },
  };
}

test("writes the restore sequence exactly once no matter how many paths fire", () => {
  const { dispose, harness } = install();
  try {
    // A SIGHUP, then the normal cleanup, then the process exit hook: three
    // separate restore paths for the same terminal.
    harness.emit("SIGHUP", "SIGHUP");
    harness.emit("exit", 0);
    dispose();
    harness.emit("exit", 0);
    expect(harness.writes).toEqual([SEQUENCE]);
  } finally {
    dispose();
  }
});

test("stops touching the terminal once the disposer has run", () => {
  const { dispose, harness } = install();
  dispose();
  expect(harness.writes).toEqual([SEQUENCE]);
  expect(terminalRestoreInstalled()).toBe(false);

  // Nothing of ours is left on the process, so a later signal or exit cannot
  // write into a terminal an embedding host has taken back over.
  harness.emit("SIGINT", "SIGINT");
  harness.emit("SIGTERM", "SIGTERM");
  harness.emit("exit", 0);
  expect(harness.writes).toEqual([SEQUENCE]);
  expect(harness.exits).toEqual([]);
});

test("asks for a graceful shutdown on the first signal and forces the second", () => {
  const graceful: string[] = [];
  const { dispose, harness } = install(SEQUENCE, (signal) => graceful.push(signal));
  try {
    harness.emit("SIGINT", "SIGINT");
    expect(graceful).toEqual(["SIGINT"]);
    expect(harness.exits).toEqual([]);

    // Hammering Ctrl-C while shutdown drags has to break out: `on` (not `once`)
    // keeps the handler attached, and the repeat exits with 128 + SIGINT.
    harness.emit("SIGINT", "SIGINT");
    expect(graceful).toEqual(["SIGINT"]);
    expect(harness.exits).toEqual([130]);

    // SIGTERM/SIGHUP count independently and use their own status.
    harness.emit("SIGHUP", "SIGHUP");
    harness.emit("SIGHUP", "SIGHUP");
    expect(harness.exits).toEqual([130, 129]);
  } finally {
    dispose();
  }
});

test("restores the terminal before a crash is printed, without owning the outcome", () => {
  const { dispose, harness } = install();
  try {
    harness.emit("uncaughtExceptionMonitor", new Error("render exploded"));
    // Ordering is the whole point: a stack trace written while the alternate
    // screen is still up disappears when the terminal switches back, and
    // `uncaughtExceptionMonitor` runs before any listener or the default
    // printer. It is observe-only, so an embedding host that recovers from the
    // error still recovers — we neither print nor exit on its behalf.
    expect(harness.log).toEqual([`write:${SEQUENCE}`]);
    expect(harness.errors).toEqual([]);
    expect(harness.exits).toEqual([]);
  } finally {
    dispose();
  }
});

test("restores before an embedding host's rejection handler runs, and leaves the outcome to it", () => {
  const hostLog: string[] = [];
  const hostHandler = () => hostLog.push("host");
  process.on("unhandledRejection", hostHandler);
  try {
    const { dispose, harness } = install();
    try {
      harness.emit("unhandledRejection", new Error("host handles this"));
      // Restore first — a host that prints a stack trace onto the alternate
      // screen would otherwise have it wiped the moment the terminal switches
      // back. The hook is prepended for exactly this ordering.
      expect(harness.writes).toEqual([SEQUENCE]);
      // …and nothing else. The host owns whether the process lives or dies.
      expect(harness.errors).toEqual([]);
      expect(harness.exits).toEqual([]);
    } finally {
      dispose();
    }
  } finally {
    process.off("unhandledRejection", hostHandler);
  }
});

test("keeps an unhandled rejection fatal when nothing else handles it", () => {
  const { dispose, harness } = install();
  try {
    harness.emit("unhandledRejection", new Error("nobody else is listening"));
    // Attaching a listener suppresses the runtime's own crash, so simply
    // observing here would turn a fatal error into a silent hang. When we are
    // the only listener we keep the default the runtime would have applied.
    expect(harness.log).toEqual([`write:${SEQUENCE}`, "stderr", "exit:1"]);
    expect(harness.errors[0]).toContain("nobody else is listening");
  } finally {
    dispose();
  }
});

test("rejects a second adapter instead of letting two share one terminal", () => {
  const first = install("<first>");
  try {
    // Sharing is not a thing that works: each adapter writes its own
    // `ENTER_ALT_SCREEN` (kitty flag pushed twice, popped once) and the first
    // one to finish calls `setRawMode(false)`/`stdin.pause()` on the
    // process-global stdin, killing input for the other. So the claim is
    // exclusive and the second caller is told so.
    expect(() => installTerminalRestore("<second>")).toThrow(TerminalAlreadyOwnedError);

    // The rejection changed nothing: the first adapter still owns the hooks and
    // has not been restored out from under itself.
    expect(terminalRestoreInstalled()).toBe(true);
    expect(first.harness.writes).toEqual([]);
    first.harness.emit("exit", 0);
    expect(first.harness.writes).toEqual(["<first>"]);
  } finally {
    first.dispose();
  }
});

test("hands ownership over once the previous adapter has released it", () => {
  const first = install("<first>");
  first.dispose();
  expect(first.harness.writes).toEqual(["<first>"]);
  expect(terminalRestoreInstalled()).toBe(false);

  // Rejection is about *concurrent* adapters, not a one-shot latch: a host that
  // restarts the TUI must be able to.
  const second = install("<second>");
  try {
    expect(terminalRestoreInstalled()).toBe(true);
    second.harness.emit("exit", 0);
    expect(second.harness.writes).toEqual(["<second>"]);
  } finally {
    second.dispose();
  }
});

test("swallows a failing write so the real crash still surfaces", () => {
  const { dispose, harness } = install(SEQUENCE, undefined, () => {
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  });
  try {
    // EPIPE on a closed stdout must not replace the reason we are dying.
    expect(() => harness.emit("unhandledRejection", new Error("original"))).not.toThrow();
    expect(harness.errors[0]).toContain("original");
  } finally {
    dispose();
  }
});

test("retries a restore that failed with a transient error", () => {
  let attempts = 0;
  const { dispose, harness } = install(SEQUENCE, undefined, () => {
    attempts += 1;
    // Fail every attempt of the first restore, then let the next hook through.
    if (attempts <= 8) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
    return undefined;
  });
  try {
    harness.emit("SIGHUP", "SIGHUP");
    expect(attempts).toBe(8);

    // Marking the terminal restored before the write succeeded used to make
    // this permanent: one EAGAIN and every later path skipped the restore.
    harness.emit("exit", 0);
    expect(harness.writes.at(-1)).toBe(SEQUENCE);
  } finally {
    dispose();
  }
});

test("keeps the hooks up when the disposer's restore never lands", () => {
  let attempts = 0;
  const { dispose, harness } = install(SEQUENCE, undefined, () => {
    attempts += 1;
    // Every attempt of the first restore fails transiently; the retry from the
    // `exit` hook succeeds.
    if (attempts <= 8) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
    return undefined;
  });
  try {
    dispose();
    // The disposer exhausted its budget without writing a byte. Detaching here
    // would have thrown away the last chance to restore the terminal.
    expect(attempts).toBe(8);
    expect(terminalRestoreInstalled()).toBe(true);

    harness.emit("exit", 0);
    expect(harness.writes.at(-1)).toBe(SEQUENCE);
  } finally {
    dispose();
  }
});

test("lets a new adapter take over from an owner whose restore never landed", () => {
  const stuck = install(SEQUENCE, undefined, () => {
    throw Object.assign(new Error("busy"), { code: "EAGAIN" });
  });
  stuck.dispose();
  // Hooks still up for a retry, but ownership was handed back — a host
  // restarting the TUI must not be told the terminal is still taken.
  expect(terminalRestoreInstalled()).toBe(true);

  const next = install("<next>");
  try {
    next.harness.emit("exit", 0);
    expect(next.harness.writes).toEqual(["<next>"]);
    // The stuck owner's hooks were replaced, not layered on top of.
    expect(stuck.harness.writes.length).toBeGreaterThan(0);
  } finally {
    next.dispose();
  }
});

test("gives up permanently on a closed stdout instead of spinning", () => {
  let attempts = 0;
  const { dispose, harness } = install(SEQUENCE, undefined, () => {
    attempts += 1;
    throw Object.assign(new Error("gone"), { code: "EPIPE" });
  });
  try {
    // EPIPE is not transient: one attempt, no retry loop, no hang on the way
    // out of the process.
    harness.emit("exit", 0);
    expect(attempts).toBe(1);
  } finally {
    dispose();
  }
});

test("finishes a short write instead of dropping the rest of the sequence", () => {
  // `writeSync` returns a byte count and is free to accept only part of the
  // buffer. The old code ignored that return value entirely, so the tail of the
  // restore sequence was silently lost.
  let first = true;
  const { dispose, harness } = install(SEQUENCE, undefined, () => {
    if (!first) return undefined;
    first = false;
    return 3;
  });
  try {
    dispose();
    expect(harness.writes).toEqual([SEQUENCE, SEQUENCE.slice(3)]);
  } finally {
    dispose();
  }
});

test("reinstalls cleanly for a second TUI session in the same process", () => {
  const first = install();
  first.dispose();
  const second = install();
  try {
    // A fresh install resets the idempotency flag: an embedding host that
    // starts the TUI again must get its terminal restored again.
    expect(second.harness.writes).toEqual([]);
    second.harness.emit("exit", 0);
    expect(second.harness.writes).toEqual([SEQUENCE]);
  } finally {
    second.dispose();
  }
});
