/**
 * Process "A" of the cross-process inbox-claim tests
 * (`tests/runtime/remote-session-inbox-claim-ownership.test.ts`). It shares the
 * parent's SQLite file (the environment — `SESSIONS_DB_PATH` and the state
 * dirs — is inherited) and runs the REAL live ask-reply path, but its
 * caller-room injection stalls: it prints `STALLED`, waits for a `GO` line on
 * stdin, then either runs the real injection (`real`) or fails (`fail`), and
 * prints `RESULT <outcome json>`.
 *
 *   bun remote-session-claim-worker.ts <real|fail> <json {topic, userId, delivery}>
 */
import * as inbox from "../../src/runtime/remote-session-inbox";

const [after = "real", raw = "{}"] = process.argv.slice(2);
const args = JSON.parse(raw) as {
  topic: { id: string; title: string };
  userId: string;
  delivery: Parameters<typeof inbox.deliverRemoteSessionInbox>[0]["delivery"];
};

let buffered = "";
const lines: string[] = [];
let wake: (() => void) | null = null;
process.stdin.on("data", (chunk: Buffer) => {
  buffered += chunk.toString("utf8");
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    lines.push(buffered.slice(0, newline).trim());
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf("\n");
  }
  wake?.();
});

async function waitFor(line: string): Promise<void> {
  while (!lines.includes(line)) {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}

const real = (await import("../../src/runtime/turn-runner")).deliverAskCallbackToCaller;
inbox.setRemoteSessionAskReplyDeliverer(async (pending, ...rest) => {
  process.stdout.write("STALLED\n");
  await waitFor("GO");
  if (after === "fail") return false;
  return real(pending, ...rest);
});

const outcome = await inbox.deliverRemoteSessionInbox({
  topic: { id: args.topic.id, title: args.topic.title, agent: undefined },
  userId: args.userId,
  actorUserId: args.userId,
  delivery: args.delivery,
});
process.stdout.write(`RESULT ${JSON.stringify(outcome)}\n`, () => process.exit(0));
