import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { after, before, test } from "node:test";
import { startPublicGateway } from "./public-gateway.mjs";

const servers = [];
let gateway;
let webPort;
let lorePort;
let quicPort;

before(async () => {
  const web = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`web:${request.url}`);
  });
  webPort = await listen(web);
  servers.push(web);

  const lore = http2.createServer();
  lore.on("request", (request, response) => {
    response.writeHead(200, {
      "content-type": "application/grpc",
    });
    response.addTrailers({ "grpc-status": "0" });
    response.end(`grpc:${request.url}:${request.authority}`);
  });
  lorePort = await listen(lore);
  servers.push(lore);

  const quic = dgram.createSocket("udp4");
  quic.on("message", (message, remote) => {
    quic.send(`quic:${message}`, remote.port, remote.address);
  });
  quicPort = await bindUdp(quic);
  servers.push(quic);

  const publicPort = await reservePublicPort();
  gateway = await startPublicGateway({
    publicHost: "0.0.0.0",
    publicPort,
    internalHost: "127.0.0.1",
    webInternalUrl: `http://127.0.0.1:${webPort}`,
    loreGrpcInternalUrl: `127.0.0.1:${lorePort}`,
    loreQuicInternalUrl: `127.0.0.1:${quicPort}`,
    udpIdleTimeoutMs: 1_000,
  });
});

after(async () => {
  await gateway?.close();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          if (server instanceof dgram.Socket) {
            server.close(resolve);
          } else {
            server.close(resolve);
          }
        }),
    ),
  );
});

test("routes browser HTTP to the web backend", async () => {
  const response = await fetch(`http://127.0.0.1:${gateway.port}/login`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "web:/login");
});

test("accepts browser HTTP on IPv6 localhost", async () => {
  const response = await fetch(`http://[::1]:${gateway.port}/login`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "web:/login");
});

test("routes Lore gRPC over the same TCP port", async () => {
  const client = http2.connect(`http://127.0.0.1:${gateway.port}`);
  try {
    const response = await new Promise((resolve, reject) => {
      const request = client.request({
        ":method": "POST",
        ":path": "/lore.repository.v1.RepositoryService/List",
        ":authority": "lore.example.test:3000",
        "content-type": "application/grpc",
        te: "trailers",
      });
      let status;
      let body = "";
      let trailers;
      request.on("response", (headers) => {
        status = headers[":status"];
      });
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("trailers", (value) => {
        trailers = value;
      });
      request.on("end", () => resolve({ status, body, trailers }));
      request.on("error", reject);
      request.end();
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.body,
      "grpc:/lore.repository.v1.RepositoryService/List:lore.example.test:3000",
    );
    assert.equal(response.trailers["grpc-status"], "0");
  } finally {
    client.close();
  }
});

test("routes QUIC UDP through the same public port", async () => {
  const client = dgram.createSocket("udp4");
  try {
    const response = await new Promise((resolve, reject) => {
      client.once("error", reject);
      client.once("message", (message) => resolve(message.toString()));
      client.send("ping", gateway.port, "127.0.0.1");
    });
    assert.equal(response, "quic:ping");
  } finally {
    client.close();
  }
});

test("stays available after a client resets its TCP connection", async () => {
  const socket = net.connect(gateway.port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    "POST /lore.repository.v1.RepositoryService/List HTTP/2.0\r\n\r\n",
  );
  socket.resetAndDestroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const response = await fetch(`http://127.0.0.1:${gateway.port}/login`);
  assert.equal(response.status, 200);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function bindUdp(socket) {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve(socket.address().port);
    });
  });
}

async function reservePublicPort() {
  for (let port = 23_000; port < 24_000; port += 1) {
    const tcp = net.createServer();
    const udp = dgram.createSocket("udp4");
    try {
      await listenOnPort(tcp, port);
      await bindUdpPort(udp, port);
      return port;
    } catch {
      // Try the next port. Windows may reserve individual UDP ports.
    } finally {
      await Promise.all([closeServer(tcp), closeUdp(udp)]);
    }
  }
  throw new Error("No test port is available for TCP and UDP");
}

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function bindUdpPort(socket, port) {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(resolve);
  });
}

function closeUdp(socket) {
  return new Promise((resolve) => {
    try {
      socket.close(resolve);
    } catch {
      resolve();
    }
  });
}
