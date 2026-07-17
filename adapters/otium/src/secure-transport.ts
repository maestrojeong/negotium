function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function credentialTransportUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain URL credentials`);
  return url;
}

export function assertSecureCentralUrl(value: string): void {
  const url = credentialTransportUrl(value, "Otium central URL");
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return;
  throw new Error("Otium central requires HTTPS or loopback HTTP");
}

export function assertSecureRelayUrl(value: string): void {
  const url = credentialTransportUrl(value, "Otium relay URL");
  if (url.protocol === "https:" || url.protocol === "wss:") return;
  if ((url.protocol === "http:" || url.protocol === "ws:") && isLoopbackHostname(url.hostname)) {
    return;
  }
  throw new Error("Otium relay requires HTTPS/WSS or loopback HTTP/WS");
}
