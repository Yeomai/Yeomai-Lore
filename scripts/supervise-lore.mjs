import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const [executable, configPath, pidFile, socketFile] = process.argv.slice(2);
if (!executable || !configPath || !pidFile || !socketFile) {
  console.error(
    "Usage: supervise-lore.mjs <loreserver> <config-dir> <pid-file> <socket-file>",
  );
  process.exit(2);
}

await mkdir(path.dirname(pidFile), { recursive: true });
await mkdir(path.dirname(socketFile), { recursive: true });

let child;
let stopping = false;
let restartRequested = false;
const restartAcks = [];
await rm(socketFile, { force: true });
const controlServer = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.once("data", (data) => {
    if (String(data).trim() === "restart" && child) {
      restartRequested = true;
      restartAcks.push(socket);
      child.kill("SIGTERM");
    } else {
      socket.end("error\n");
    }
  });
});
controlServer.on("error", (error) => {
  console.error("supervisor control server failed", error);
  stopping = true;
  child?.kill("SIGTERM");
});
await new Promise((resolve, reject) => {
  controlServer.once("error", reject);
  controlServer.listen(socketFile, resolve);
});
await chmod(socketFile, 0o600);
await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });

process.on("SIGUSR2", () => {
  restartRequested = true;
  child?.kill("SIGTERM");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    child?.kill("SIGTERM");
  });
}

try {
  while (!stopping) {
    restartRequested = false;
    child = spawn(executable, ["--config", configPath], {
      stdio: "inherit",
    });
    await once(child, "exit");
    child = undefined;
    for (const socket of restartAcks.splice(0)) {
      socket.end(restartRequested ? "ok\n" : "error\n");
    }
    if (!stopping) {
      console.error(
        restartRequested
          ? "Lore service restart requested"
          : "Lore service exited unexpectedly; restarting",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
} finally {
  controlServer.close();
  for (const socket of restartAcks.splice(0)) {
    socket.end("error\n");
  }
  await rm(pidFile, { force: true });
  await rm(socketFile, { force: true });
}
