import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { restartLore } from "../src/lore-supervisor.ts";

describe("Lore supervisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([1, 4321])("accepts supervisor PID %i", async (supervisorPid) => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-supervisor-test-"));
    const pidFile = path.join(directory, "lore-supervisor.pid");
    writeFileSync(pidFile, `${supervisorPid}\n`);
    const config = loadConfig({
      NODE_ENV: "test",
      LORE_SUPERVISOR_PID_FILE: pidFile,
      LORE_SUPERVISOR_SOCKET: path.join(directory, "missing.sock"),
      LORE_HTTP_URL: "http://lore.test:41339",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    let checks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        checks += 1;
        return new Response(null, {
          status: checks === 1 ? 503 : 200,
        });
      }),
    );
    try {
      await expect(restartLore(config)).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledWith(supervisorPid, "SIGUSR2");
      expect(checks).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prefers the supervisor socket over PID signaling", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-supervisor-test-"));
    const socketPath = path.join(directory, "supervisor.sock");
    const config = loadConfig({
      NODE_ENV: "test",
      LORE_SUPERVISOR_PID_FILE: path.join(directory, "missing.pid"),
      LORE_SUPERVISOR_SOCKET: socketPath,
      LORE_HTTP_URL: "http://lore.test:41339",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    let command = "";
    let checks = 0;
    const server = createServer((socket) => {
      socket.once("data", (data) => {
        command = String(data).trim();
        socket.end("ok\n");
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        checks += 1;
        return new Response(null, {
          status: checks === 1 ? 503 : 200,
        });
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(restartLore(config)).resolves.toBeUndefined();
      expect(command).toBe("restart");
      expect(kill).not.toHaveBeenCalled();
      expect(checks).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
