import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { AppError } from "@lore-portal/shared";
import type { AppConfig } from "./config.ts";
import { isLoreReady } from "./readiness.ts";

export async function restartLore(config: AppConfig): Promise<void> {
  const restartedViaSocket = await requestSupervisorRestart(
    config.loreSupervisorSocket,
  );
  if (!restartedViaSocket) {
    await signalSupervisorPid(config);
    await waitForLoreDown(config);
  }
  await waitForLoreUp(config);
}

async function waitForLoreDown(config: AppConfig): Promise<void> {
  const deadline = Date.now() + 35_000;
  let stopped = false;
  while (Date.now() < deadline) {
    await delay(250);
    if (!(await isLoreReady(config))) {
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    throw new AppError(
      "lore_unavailable",
      503,
      "Lore restart did not begin",
    );
  }
}

async function waitForLoreUp(config: AppConfig): Promise<void> {
  const deadline = Date.now() + 90_000;
  let healthySince: number | null = null;
  while (Date.now() < deadline) {
    if (await isLoreReady(config)) {
      healthySince ??= Date.now();
      if (Date.now() - healthySince >= 1_500) {
        return;
      }
    } else {
      healthySince = null;
    }
    await delay(250);
  }
  throw new AppError(
    "lore_unavailable",
    503,
    "Lore restart timed out",
  );
}

async function signalSupervisorPid(config: AppConfig): Promise<void> {
  const pidText = await readFile(config.loreSupervisorPidFile, "utf8").catch(
    () => null,
  );
  const pid = Number(pidText?.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AppError(
      "lore_unavailable",
      503,
      "Lore restart supervisor is unavailable",
    );
  }

  try {
    process.kill(pid, "SIGUSR2");
  } catch {
    throw new AppError(
      "lore_unavailable",
      503,
      "Lore restart supervisor is unavailable",
    );
  }
}

function requestSupervisorRestart(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(socketPath);
    const finish = (restarted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(restarted);
    };
    const timeout = setTimeout(() => finish(false), 35_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write("restart\n"));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("data", (data) => finish(String(data).trim() === "ok"));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
