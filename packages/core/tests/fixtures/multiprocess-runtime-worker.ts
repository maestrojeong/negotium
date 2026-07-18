const [mode, value = "", extra = ""] = process.argv.slice(2);

switch (mode) {
  case "bus-listen": {
    const { runtimeBus } = await import("../../src/index");
    const stop = runtimeBus().subscribe((event) => {
      if (event.topicId !== value || event.type !== "topic-updated") return;
      stop();
      process.stdout.write(`EVENT ${event.topicId}\n`, () => process.exit(0));
    });
    process.stdout.write("READY\n");
    setTimeout(() => process.exit(2), 5_000);
    break;
  }
  case "bus-write": {
    const { runtimeBus } = await import("../../src/index");
    runtimeBus().broadcastTopicUpdated(value);
    process.stdout.write("WROTE\n");
    break;
  }
  case "delivery-ack-listen": {
    const { prepareDeliveryAck } = await import("../../src/index");
    const waiter = prepareDeliveryAck(extra, 1_000, 1_000);
    process.stdout.write("READY\n");
    const result = await waiter.promise;
    process.stdout.write(`ACK ${JSON.stringify(result)}\n`);
    break;
  }
  case "delivery-ack-write": {
    const { claimDeliveryAck, resolveDeliveryAck } = await import("../../src/index");
    claimDeliveryAck(value, extra);
    resolveDeliveryAck(value, extra, { ok: true });
    process.stdout.write("WROTE\n");
    break;
  }
  case "singleton": {
    const { acquireRuntimeProcessLease } = await import("../../src/index");
    const lease = acquireRuntimeProcessLease(value);
    if (!lease) {
      process.stdout.write("BUSY\n");
      break;
    }
    process.stdout.write("CLAIMED\n");
    setTimeout(() => {
      lease.stop();
      process.exit(0);
    }, 2_000);
    break;
  }
  case "node": {
    const { startDefaultNode } = await import("../../../node/src/index");
    const node = await startDefaultNode({ port: 0 });
    process.stdout.write(`READY ${node.port}\n`);
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      if (String(chunk).includes("stop")) break;
    }
    await node.stop();
    break;
  }
  case "inbox-worker": {
    const { getRuntimeProcessLease, startSessionInboxWorker } = await import("../../src/index");
    const stop = startSessionInboxWorker();
    let lastOwnerPid: number | null = null;
    const reportOwner = (prefix: "READY" | "OWNER") => {
      const ownerPid = getRuntimeProcessLease("worker:session-inbox")?.pid ?? null;
      lastOwnerPid = ownerPid;
      process.stdout.write(`${prefix} ${ownerPid ?? "none"}\n`);
    };
    reportOwner("READY");
    const timer = setInterval(() => {
      const ownerPid = getRuntimeProcessLease("worker:session-inbox")?.pid ?? null;
      if (ownerPid !== lastOwnerPid) reportOwner("OWNER");
    }, 100);
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      if (String(chunk).includes("stop")) break;
    }
    clearInterval(timer);
    stop();
    break;
  }
  default:
    throw new Error(`unknown worker mode: ${mode}`);
}

export {};
