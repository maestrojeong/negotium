import { createHmac } from "node:crypto";

export function deriveBgBashContextCapability(
  runtimeCapability: string,
  userId: string,
  topic: string,
): string {
  return createHmac("sha256", runtimeCapability).update(`${userId}\0${topic}`).digest("hex");
}
