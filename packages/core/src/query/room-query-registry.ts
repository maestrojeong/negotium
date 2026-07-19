export interface RuntimeTurnLeaseLike {
  topicId: string;
  queryId: string;
  ownerId: string;
}

export interface RoomQueryControlLike<TAbortReason> {
  topicId: string;
  roomId?: string;
  queryId: string;
  origin: string;
  abortController: AbortController;
  abortReason: TAbortReason;
  startedAt?: number;
}

export interface RoomQueryRegistryHost<TLease extends RuntimeTurnLeaseLike, TAbortReason> {
  instanceId: string;
  internalAbortReason: TAbortReason;
  externalAbortReason: TAbortReason;
  listLeases(): readonly TLease[];
  getLease(roomId: string): TLease | null;
  claimLease(input: { topicId: string; queryId: string; origin: string }): boolean;
  heartbeatLease(
    roomId: string,
    queryId: string,
  ): { owned: boolean; abortRequested: boolean; abortReason?: "internal" | "external" | null };
  releaseLease(roomId: string, queryId: string): void;
  requestAbort(roomId: string, reason: "internal" | "external"): boolean;
  now?: () => number;
  heartbeatMs?: number;
}

export type RoomQueryDecision<TControl, TLease extends RuntimeTurnLeaseLike> =
  | { action: "proceed" }
  | { action: "abort-replace"; running: TControl }
  | { action: "defer" }
  | { action: "remote-defer"; running: TLease }
  | { action: "remote-abort-wait"; running: TLease };

const ISOLATED_TURN_ROOM_MARKER = "::isolated-turn::";

/** Build a private scheduling key for a forked turn that may run beside its topic. */
export function isolatedTurnRoomId(topicId: string, queryId: string): string {
  return `${topicId}${ISOLATED_TURN_ROOM_MARKER}${queryId}`;
}

export function isIsolatedTurnRoomId(roomId: string): boolean {
  return roomId.includes(ISOLATED_TURN_ROOM_MARKER);
}

export function isUserOrigin(origin: string | undefined): boolean {
  return !origin || origin === "user";
}

export interface RoomQueryRegistry<
  TControl extends RoomQueryControlLike<TAbortReason>,
  TLease extends RuntimeTurnLeaseLike,
  TAbortReason,
> {
  get(roomId: string): TControl | undefined;
  listRunningTopicQueries(): Map<string, string>;
  listRunningTopicIds(): Set<string>;
  isTopicRunning(topicId: string): boolean;
  status(topicId: string, queryId: string): "running" | "not_found";
  set(control: TControl): boolean;
  clear(roomId: string, queryId: string): void;
  abort(roomId: string, reason?: TAbortReason): boolean;
  abortAll(reason?: TAbortReason): number;
  decide(topicId: string, incomingOrigin: string): RoomQueryDecision<TControl, TLease>;
}

/**
 * Create an isolated room-query registry. Mutable maps and timers belong to
 * the caller; lease persistence and logging remain host-owned.
 */
export function createRoomQueryRegistry<
  TControl extends RoomQueryControlLike<TAbortReason>,
  TLease extends RuntimeTurnLeaseLike,
  TAbortReason,
>(
  host: RoomQueryRegistryHost<TLease, TAbortReason>,
): RoomQueryRegistry<TControl, TLease, TAbortReason> {
  const activeByRoom = new Map<string, TControl>();
  const leaseMonitors = new Map<string, ReturnType<typeof setInterval>>();
  const now = host.now ?? Date.now;
  const heartbeatMs = host.heartbeatMs ?? 1_000;

  function get(roomId: string): TControl | undefined {
    return activeByRoom.get(roomId);
  }

  function listRunningTopicQueries(): Map<string, string> {
    const queries = new Map(
      [...activeByRoom.entries()]
        .filter(([roomId]) => !isIsolatedTurnRoomId(roomId))
        .map(([roomId, control]) => [roomId, control.queryId]),
    );
    for (const lease of host.listLeases()) {
      if (isIsolatedTurnRoomId(lease.topicId)) continue;
      if (!queries.has(lease.topicId)) queries.set(lease.topicId, lease.queryId);
    }
    return queries;
  }

  function listRunningTopicIds(): Set<string> {
    return new Set(listRunningTopicQueries().keys());
  }

  function isTopicRunning(topicId: string): boolean {
    return activeByRoom.has(topicId) || host.getLease(topicId) !== null;
  }

  function status(topicId: string, queryId: string): "running" | "not_found" {
    if (activeByRoom.get(topicId)?.queryId === queryId) return "running";
    return host.getLease(topicId)?.queryId === queryId ? "running" : "not_found";
  }

  function set(control: TControl): boolean {
    const roomId = control.roomId ?? control.topicId;
    control.startedAt ??= now();
    if (!host.claimLease({ topicId: roomId, queryId: control.queryId, origin: control.origin })) {
      return false;
    }

    const previousMonitor = leaseMonitors.get(roomId);
    if (previousMonitor) clearInterval(previousMonitor);
    activeByRoom.set(roomId, control);
    const monitor = setInterval(() => {
      const current = activeByRoom.get(roomId);
      if (!current || current.queryId !== control.queryId) {
        clearInterval(monitor);
        if (leaseMonitors.get(roomId) === monitor) leaseMonitors.delete(roomId);
        return;
      }
      const heartbeat = host.heartbeatLease(roomId, control.queryId);
      if (!heartbeat.owned) {
        control.abortReason = host.externalAbortReason;
        control.abortController.abort();
        return;
      }
      if (heartbeat.abortRequested && !control.abortController.signal.aborted) {
        control.abortReason =
          heartbeat.abortReason === "internal"
            ? host.internalAbortReason
            : host.externalAbortReason;
        control.abortController.abort();
      }
    }, heartbeatMs);
    monitor.unref?.();
    leaseMonitors.set(roomId, monitor);
    return true;
  }

  function clear(roomId: string, queryId: string): void {
    const current = activeByRoom.get(roomId);
    if (current?.queryId === queryId) {
      activeByRoom.delete(roomId);
      const monitor = leaseMonitors.get(roomId);
      if (monitor) clearInterval(monitor);
      leaseMonitors.delete(roomId);
    }
    host.releaseLease(roomId, queryId);
  }

  function abort(roomId: string, reason = host.externalAbortReason): boolean {
    const running = activeByRoom.get(roomId);
    const wireReason = reason === host.internalAbortReason ? "internal" : "external";
    if (running) {
      running.abortReason = reason;
      running.abortController.abort();
      host.requestAbort(roomId, wireReason);
      return true;
    }
    return host.requestAbort(roomId, wireReason);
  }

  function abortAll(reason = host.externalAbortReason): number {
    let aborted = 0;
    for (const running of activeByRoom.values()) {
      running.abortReason = reason;
      if (!running.abortController.signal.aborted) {
        running.abortController.abort();
        aborted++;
      }
    }
    return aborted;
  }

  function decide(topicId: string, incomingOrigin: string): RoomQueryDecision<TControl, TLease> {
    const running = activeByRoom.get(topicId);
    if (!running) {
      const remote = host.getLease(topicId);
      if (!remote || remote.ownerId === host.instanceId) return { action: "proceed" };
      return isUserOrigin(incomingOrigin)
        ? { action: "remote-abort-wait", running: remote }
        : { action: "remote-defer", running: remote };
    }
    if (!isUserOrigin(incomingOrigin)) return { action: "defer" };
    return { action: "abort-replace", running };
  }

  return {
    get,
    listRunningTopicQueries,
    listRunningTopicIds,
    isTopicRunning,
    status,
    set,
    clear,
    abort,
    abortAll,
    decide,
  };
}
