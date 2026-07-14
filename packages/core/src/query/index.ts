// Live query-control exports.

export type {
  DeferredInject,
  NewQueryDecision,
  RoomQueryControl,
} from "./active-rooms";
export {
  abortAllRooms,
  abortRoom,
  cancelDeferredInject,
  clearRoomQuery,
  decideNewQuery,
  deferInject,
  getRoomQuery,
  InterSessionQueue,
  interSessionQueue,
  isUserOrigin,
  setRoomQuery,
  takeDeferredInject,
  wsAbortReason,
} from "./active-rooms";
export type { HandleAgentQueryOutcome, HandleAgentQueryParams } from "./types";
export { AbortReason } from "./types";
