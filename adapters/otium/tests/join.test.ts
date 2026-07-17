import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "@negotium/core";
import { joinFilePath, loadJoin, parseInviteCode, saveJoin } from "@/join";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

afterEach(() => {
  if (existsSync(joinFilePath())) unlinkSync(joinFilePath());
  delete process.env.OTIUM_CENTRAL_URL;
  delete process.env.OTIUM_CELL_ID;
  delete process.env.OTIUM_CELL_SECRET;
  delete process.env.OTIUM_RELAY_URL;
});

describe("parseInviteCode", () => {
  test("decodes a v0 bundle and strips a trailing slash from central", () => {
    const code = encode({
      v: 1,
      central: "http://127.0.0.1:4600/",
      cellId: "cell_abc",
      secret: "rcs_xyz",
    });
    const join = parseInviteCode(code);
    expect(join).toEqual({
      v: 1,
      central: "http://127.0.0.1:4600",
      cellId: "cell_abc",
      secret: "rcs_xyz",
    });
  });

  test("preserves an optional relay origin", () => {
    const code = encode({
      central: "https://central.example",
      relay: "wss://relay.example/",
      cellId: "cell_abc",
      secret: "rcs_xyz",
    });
    expect(parseInviteCode(code).relay).toBe("wss://relay.example");
  });

  test("tolerates surrounding whitespace", () => {
    const code = `  ${encode({ central: "https://c.example", cellId: "cell_1", secret: "rcs_1" })}\n`;
    expect(parseInviteCode(code).cellId).toBe("cell_1");
  });

  test("rejects garbage, non-JSON and non-object codes", () => {
    expect(() => parseInviteCode("")).toThrow("empty");
    expect(() => parseInviteCode("@@@@")).toThrow();
    expect(() => parseInviteCode(Buffer.from("not json").toString("base64url"))).toThrow("JSON");
    expect(() => parseInviteCode(encode([1, 2, 3]))).toThrow("JSON object");
  });

  test("rejects missing or invalid fields", () => {
    expect(() => parseInviteCode(encode({ central: "ftp://x", cellId: "c", secret: "s" }))).toThrow(
      "central",
    );
    expect(() => parseInviteCode(encode({ central: "http://x", secret: "s" }))).toThrow("cellId");
    expect(() => parseInviteCode(encode({ central: "http://x", cellId: "c" }))).toThrow("secret");
  });
});

describe("saveJoin / loadJoin", () => {
  test("persists under DATA_DIR with 0600 and round-trips", () => {
    const join = { v: 1, central: "http://127.0.0.1:4600", cellId: "cell_a", secret: "rcs_b" };
    const path = saveJoin(join);
    expect(path).toBe(joinFilePath());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadJoin()).toEqual(join);
  });

  test("re-saving the same credentials is idempotent", () => {
    const join = { central: "https://central.example", cellId: "cell_a", secret: "rcs_a" };
    saveJoin(join);
    expect(saveJoin(join)).toBe(joinFilePath());
    expect(loadJoin()).toEqual(join);
  });

  test("requires explicit replacement of different credentials", () => {
    saveJoin({ central: "https://one.example", cellId: "cell_one", secret: "rcs_one" });
    const replacement = {
      central: "https://two.example",
      cellId: "cell_two",
      secret: "rcs_two",
    };
    expect(() => saveJoin(replacement)).toThrow("--replace");
    expect(loadJoin()?.cellId).toBe("cell_one");
    saveJoin(replacement, { replaceExisting: true });
    expect(loadJoin()).toEqual(replacement);
  });

  test("serializes a concurrent explicit replacement behind the join lock", async () => {
    const initial = { central: "https://one.example", cellId: "cell_one", secret: "rcs_one" };
    const replacement = {
      central: "https://two.example",
      cellId: "cell_two",
      secret: "rcs_two",
    };
    saveJoin(initial);
    const moduleUrl = new URL("../src/join.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const {withJoinCredentialLock}=await import(${JSON.stringify(moduleUrl)}); withJoinCredentialLock(()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300));`,
      ],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    const lockPath = resolve(DATA_DIR, ".otium-join.lock");
    for (let attempt = 0; attempt < 100 && !existsSync(lockPath); attempt += 1) {
      await Bun.sleep(5);
    }
    expect(existsSync(lockPath)).toBe(true);
    expect(() => saveJoin(replacement, { replaceExisting: true })).toThrow("in progress");
    expect(loadJoin()).toEqual(initial);
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");

    saveJoin(replacement, { replaceExisting: true });
    expect(loadJoin()).toEqual(replacement);
  });

  test("returns null when nothing is persisted", () => {
    expect(loadJoin()).toBeNull();
  });

  test("returns null on a corrupt join file (fail-closed)", async () => {
    await Bun.write(joinFilePath(), "not-json{{{");
    expect(loadJoin()).toBeNull();
  });

  test("full env triple overrides the file; a partial triple is ignored", () => {
    saveJoin({ central: "http://file.example", cellId: "cell_file", secret: "rcs_file" });
    process.env.OTIUM_CENTRAL_URL = "http://env.example";
    process.env.OTIUM_CELL_ID = "cell_env";
    process.env.OTIUM_CELL_SECRET = "rcs_env";
    expect(loadJoin()).toEqual({
      central: "http://env.example",
      cellId: "cell_env",
      secret: "rcs_env",
    });

    delete process.env.OTIUM_CELL_SECRET;
    expect(loadJoin()?.cellId).toBe("cell_file");
  });

  test("loads an optional relay URL from the environment", () => {
    process.env.OTIUM_CENTRAL_URL = "http://env.example";
    process.env.OTIUM_CELL_ID = "cell_env";
    process.env.OTIUM_CELL_SECRET = "rcs_env";
    process.env.OTIUM_RELAY_URL = "https://relay.example/";
    expect(loadJoin()?.relay).toBe("https://relay.example");
  });
});
