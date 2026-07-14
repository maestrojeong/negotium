export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
