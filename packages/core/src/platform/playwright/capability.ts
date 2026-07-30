import { createHmac } from "node:crypto";

export function browserOwnerCapability(capability: string, owner: string): string {
  return createHmac("sha256", capability).update(owner).digest("hex");
}
