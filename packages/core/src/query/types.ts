// --- Abort reason ---

export enum AbortReason {
  None = "none",
  Internal = "internal", // replaced by a newer query on the same topic
  External = "external", // /abort command or abort_session via session-inbox
  Infrastructure = "infrastructure", // required runtime dependency exited unexpectedly
}
