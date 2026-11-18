import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const children = new Map();
const restartAcks = [];
let stopping = false;
let controlServer;
const supervisorPidFile = process.env.LORE_SUPERVISOR_PID_FILE;
const supervisorSocket = process.env.LORE_SUPERVISOR_SOCKET;
const webInternalPort = process.env.WEB_INTERNAL_PORT ?? "41340";
const publicGatewayPort = process.env.PUBLIC_GATEWAY_PORT ?? "3000";
if (supervisorPidFile) {
  mkdirSync(path.dirname(supervisorPidFile), { recursive: true });
  writeFileSync(supervisorPidFile, `${process.pid}\n`, { mode: 0o600 });
}

function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  controlServer?.close();
  if (supervisorSocket) {
    rmSync(supervisorSocket, { force: true });
  }

  for (const child of children.values()) {
    child.kill("SIGTERM");
  }
  for (const socket of restartAcks.splice(0)) {
    socket.end("error\n");
  }

  const forceExit = setTimeout(() => process.exit(exitCode), 10_000);
  Promise.all(
    [...children.values()].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
          } else {
            child.once("exit", resolve);
          }
        }),
    ),
  ).finally(() => {
    clearTimeout(forceExit);
    if (supervisorPidFile) {
      rmSync(supervisorPidFile, { force: true });
    }
    process.exit(exitCode);
  });
}

function startControlServer() {
  if (!supervisorSocket) return;
  mkdirSync(path.dirname(supervisorSocket), { recursive: true });
  rmSync(supervisorSocket, { force: true });
  controlServer = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (data) => {
      const command = String(data).trim();
      if (command === "restart" && children.has("lore")) {
        restartAcks.push(socket);
        children.get("lore").kill("SIGTERM");
      } else {
        socket.end("error\n");
      }
    });
  });
  controlServer.on("error", (error) => {
    console.error("supervisor control server failed", error);
    shutdown(1);
  });
  controlServer.listen(supervisorSocket, () => {
    chmodSync(supervisorSocket, 0o600);
  });
}

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  children.set(name, child);

  child.on("error", (error) => {
    console.error(`${name} failed to start`, error);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    if (name === "lore") {
      for (const socket of restartAcks.splice(0)) {
        socket.end("ok\n");
      }
      console.error("lore exited; restarting", { code, signal });
      setTimeout(startLore, 500);
      return;
    }
    console.error(`${name} exited`, { code, signal });
    shutdown(code ?? 1);
  });
}

function startLore() {
  if (stopping || children.has("lore")) return;
  start("lore", "/usr/local/bin/loreserver", [
    "--config",
    "/data/config",
  ]);
}

async function waitFor(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (stopping) return;
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process manager retries while the application is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGUSR2", () => {
  children.get("lore")?.kill("SIGTERM");
});

startControlServer();
start("api", process.execPath, ["dist/index.js"], {
  cwd: "/app/apps/server",
});

try {
  await waitFor("http://127.0.0.1:4000/health_check");
  if (!stopping) {
    start("web", process.execPath, ["apps/web/server.js"], {
      cwd: "/opt/web",
      env: {
        HOSTNAME: "0.0.0.0",
        PORT: webInternalPort,
      },
    });
  }
  if (!stopping) {
    await waitFor(
      `http://127.0.0.1:${webInternalPort}/.well-known/openid-configuration`,
    );
  }
  if (!stopping) {
    start("gateway", process.execPath, ["/usr/local/bin/public-gateway.mjs"], {
      env: {
        WEB_INTERNAL_URL: `http://127.0.0.1:${webInternalPort}`,
        LORE_GRPC_INTERNAL_URL: process.env.LORE_GRPC_URL,
        LORE_QUIC_INTERNAL_URL:
          process.env.LORE_QUIC_INTERNAL_URL ??
          process.env.LORE_GRPC_URL,
        PUBLIC_GATEWAY_HOST: "0.0.0.0",
        PUBLIC_GATEWAY_PORT: publicGatewayPort,
      },
    });
  }
  if (!stopping) {
    await waitFor(`http://127.0.0.1:${publicGatewayPort}/health_check`);
  }
  if (!stopping) {
    startLore();
  }
  if (!stopping) {
    await waitFor("http://127.0.0.1:41339/health_check");
  }
} catch (error) {
  console.error("Application startup failed", error);
  shutdown(1);
}
