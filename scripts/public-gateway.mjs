import dgram from "node:dgram";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { pathToFileURL } from "node:url";

const HTTP2_PREFACE = Buffer.from(
  "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
  "ascii",
);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

export async function startPublicGateway(options = {}) {
  const config = readGatewayConfig(options);
  const state = {
    publicServer: null,
    webServer: null,
    loreServer: null,
    loreSession: null,
    udpSocket: null,
    udpSessions: new Map(),
    closed: false,
  };

  const webServer = http.createServer((request, response) => {
    proxyHttp1ToWeb(request, response, config);
  });
  webServer.on("upgrade", (request, socket, head) => {
    proxyWebSocket(request, socket, head, config);
  });
  webServer.on("clientError", (error, socket) => {
    console.error("public gateway web client error", error.message);
    socket.destroy();
  });
  await listen(webServer, config.internalHost, 0);
  state.webServer = webServer;

  const loreServer = http2.createServer({ settings: { enablePush: false } });
  loreServer.on("request", (request, response) => {
    if (isGrpcRequest(request)) {
      proxyGrpc(request, response, config, state);
      return;
    }
    proxyHttp2ToWeb(request, response, config);
  });
  loreServer.on("sessionError", (error) => {
    console.error("public gateway HTTP/2 session error", error.message);
  });
  await listen(loreServer, config.internalHost, 0);
  state.loreServer = loreServer;

  const publicServer = net.createServer({ pauseOnConnect: true }, (socket) => {
    proxyTransport(
      socket,
      webServer.address().port,
      loreServer.address().port,
      config,
    );
  });
  publicServer.on("error", (error) => {
    if (!state.closed) {
      console.error("public gateway TCP listener failed", error);
    }
  });
  const publicTcpHost =
    config.publicHost === "0.0.0.0" ? "::" : config.publicHost;
  await listen(publicServer, publicTcpHost, config.publicPort);
  state.publicServer = publicServer;

  const publicPort = publicServer.address().port;
  try {
    state.udpSocket = await startUdpProxy(
      config,
      publicPort,
      state.udpSessions,
    );
  } catch (error) {
    await closeGateway(state);
    throw error;
  }

  return {
    port: publicPort,
    close: () => closeGateway(state),
  };
}

function readGatewayConfig(options) {
  const web = endpoint(
    options.webInternalUrl ?? process.env.WEB_INTERNAL_URL,
    "127.0.0.1",
    41340,
  );
  const lore = endpoint(
    options.loreGrpcInternalUrl ?? process.env.LORE_GRPC_INTERNAL_URL,
    "127.0.0.1",
    41337,
  );
  const quic = endpoint(
    options.loreQuicInternalUrl ?? process.env.LORE_QUIC_INTERNAL_URL,
    "127.0.0.1",
    41337,
  );

  return {
    publicHost:
      options.publicHost ??
      process.env.PUBLIC_GATEWAY_HOST ??
      "0.0.0.0",
    publicPort: numberOption(
      options.publicPort ?? process.env.PUBLIC_GATEWAY_PORT,
      3000,
      true,
    ),
    internalHost:
      options.internalHost ??
      process.env.PUBLIC_GATEWAY_INTERNAL_HOST ??
      "127.0.0.1",
    web,
    lore,
    quic,
    udpIdleTimeoutMs: numberOption(
      options.udpIdleTimeoutMs ??
        process.env.PUBLIC_GATEWAY_UDP_IDLE_TIMEOUT_MS,
      120_000,
      false,
    ),
  };
}

function endpoint(value, defaultHost, defaultPort) {
  const fallback = new URL(`http://${defaultHost}:${defaultPort}`);
  if (!value) {
    return {
      host: fallback.hostname,
      port: Number(fallback.port),
    };
  }

  const parsed = new URL(
    value.includes("://") ? value : `http://${value}`,
  );
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ""),
    port: Number(parsed.port || defaultPort),
  };
}

function numberOption(value, fallback, allowZero) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    throw new Error(`Invalid numeric public gateway option: ${value}`);
  }
  return parsed;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function proxyTransport(socket, webPort, lorePort, config) {
  socket.pause();
  let buffered = Buffer.alloc(0);
  let settled = false;
  const timeout = setTimeout(() => {
    if (!settled) socket.destroy(new Error("Protocol detection timed out"));
  }, 10_000);

  const settle = (protocol) => {
    if (settled) return;
    settled = true;
    socket.pause();
    clearTimeout(timeout);
    socket.off("data", onData);

    const backendPort = protocol === "h2" ? lorePort : webPort;
    const backend = net.connect(backendPort, config.internalHost);
    backend.setNoDelay(true);
    backend.once("connect", () => {
      if (buffered.length > 0) backend.write(buffered);
      socket.pipe(backend);
      backend.pipe(socket);
      socket.resume();
    });
    backend.on("error", () => socket.destroy());
    backend.once("close", () => socket.destroy());
    socket.once("close", () => backend.destroy());
  };

  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const compared = Math.min(buffered.length, HTTP2_PREFACE.length);
    if (
      !buffered
        .subarray(0, compared)
        .equals(HTTP2_PREFACE.subarray(0, compared))
    ) {
      settle("http1");
      return;
    }
    if (buffered.length >= HTTP2_PREFACE.length) {
      settle("h2");
    }
  };
  const onSocketError = () => {
    clearTimeout(timeout);
    socket.destroy();
  };

  socket.on("data", onData);
  socket.once("error", onSocketError);
  socket.resume();
}

function proxyHttp1ToWeb(request, response, config) {
  const headers = transportHeaders(request.headers);
  const upstream = http.request({
    host: config.web.host,
    port: config.web.port,
    method: request.method,
    path: request.url,
    headers,
  });

  let responded = false;
  upstream.on("response", (upstreamResponse) => {
    responded = true;
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      transportHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (responded) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Web upstream unavailable\n");
  });

  request.pipe(upstream);
}

function proxyHttp2ToWeb(request, response, config) {
  const headers = transportHeaders(request.headers);
  delete headers[":path"];
  delete headers[":method"];
  delete headers[":scheme"];
  delete headers[":authority"];
  const upstream = http.request({
    host: config.web.host,
    port: config.web.port,
    method: request.method,
    path: request.url,
    headers,
  });

  upstream.on("response", (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      transportHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, {
        "content-type": "text/plain; charset=utf-8",
      });
    }
    response.end("Web upstream unavailable\n");
  });

  request.pipe(upstream);
}

function proxyGrpc(request, response, config, state) {
  const session = getLoreSession(config, state);
  const authority =
    request.authority ??
    request.headers[":authority"] ??
    request.headers.host ??
    `${config.lore.host}:${config.lore.port}`;
  const upstream = session.request({
    ...transportHeaders(request.headers),
    ":method": request.method,
    ":path": request.url,
    ":scheme": request.scheme ?? "http",
    ":authority": authority,
  });

  let responded = false;
  upstream.on("response", (headers) => {
    responded = true;
    const status = Number(headers[":status"] ?? 502);
    const filtered = transportHeaders(headers);
    response.writeHead(status, filtered);
  });
  upstream.on("data", (chunk) => {
    if (!response.write(chunk)) upstream.pause();
  });
  response.on("drain", () => upstream.resume());
  upstream.on("trailers", (trailers) => {
    response.addTrailers(trailers);
  });
  upstream.on("end", () => response.end());
  upstream.on("error", (error) => {
    if (!responded && !response.headersSent) {
      response.writeHead(502, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Lore upstream unavailable\n");
      return;
    }
    response.destroy(error);
  });

  request.on("trailers", (trailers) => {
    if (!upstream.writableEnded) upstream.addTrailers(trailers);
  });
  request.pipe(upstream);
}

function getLoreSession(config, state) {
  if (
    state.loreSession &&
    !state.loreSession.closed &&
    !state.loreSession.destroyed
  ) {
    return state.loreSession;
  }

  const session = http2.connect(
    `http://${config.lore.host}:${config.lore.port}`,
  );
  session.on("error", (error) => {
    console.error("Lore upstream HTTP/2 connection failed", error.message);
  });
  session.on("close", () => {
    if (state.loreSession === session) state.loreSession = null;
  });
  state.loreSession = session;
  return session;
}

function proxyWebSocket(request, socket, head, config) {
  const upstream = net.connect(config.web.port, config.web.host);
  upstream.once("connect", () => {
    const headers = Object.entries(request.headers)
      .flatMap(([name, value]) => {
        if (Array.isArray(value)) {
          return value.map((item) => `${name}: ${item}\r\n`);
        }
        return value === undefined ? [] : [`${name}: ${value}\r\n`];
      })
      .join("");
    upstream.write(
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`,
    );
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
}

function isGrpcRequest(request) {
  const contentType = request.headers["content-type"];
  return (
    (typeof contentType === "string" &&
      contentType.toLowerCase().startsWith("application/grpc")) ||
    /^\/(?:epic_urc|lore\.)/.test(request.url ?? "")
  );
}

function transportHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) &&
        !name.startsWith(":"),
    ),
  );
}

async function startUdpProxy(config, publicPort, sessions) {
  let socket;
  try {
    socket = dgram.createSocket({ type: "udp6", ipv6Only: false });
    await bindUdp(
      socket,
      publicPort,
      config.publicHost === "0.0.0.0" ? "::" : config.publicHost,
    );
  } catch {
    try {
      socket?.close();
    } catch {
      // The IPv6 socket may have failed before it was bound.
    }
    socket = dgram.createSocket("udp4");
    await bindUdp(socket, publicPort, config.publicHost);
  }

  socket.on("message", (message, remote) => {
    const key = `${remote.family}:${remote.address}:${remote.port}`;
    let session = sessions.get(key);
    if (!session) {
      session = dgram.createSocket("udp4");
      session.on("message", (reply) => {
        socket.send(reply, remote.port, remote.address);
      });
      session.on("error", (error) => {
        console.error("public gateway UDP session failed", error.message);
        session.close();
      });
      session.on("close", () => sessions.delete(key));
      sessions.set(key, session);
    }

    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.close();
    }, config.udpIdleTimeoutMs);
    session.idleTimer.unref();
    session.send(message, config.quic.port, config.quic.host);
  });
  socket.on("error", (error) => {
    console.error("public gateway UDP listener failed", error);
  });
  return socket;
}

function bindUdp(socket, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({ port, address: host, exclusive: true });
  });
}

async function closeGateway(state) {
  if (state.closed) return;
  state.closed = true;

  await Promise.all(
    [state.publicServer, state.webServer, state.loreServer]
      .filter(Boolean)
      .map(
        (server) =>
          new Promise((resolve) => {
            server.close(() => resolve());
          }),
      ),
  );

  state.loreSession?.close();
  for (const session of state.udpSessions.values()) {
    clearTimeout(session.idleTimer);
    session.close();
  }
  state.udpSessions.clear();
  state.udpSocket?.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPublicGateway()
    .then(({ port }) => {
      console.log(`Public gateway listening on ${port}/TCP and ${port}/UDP`);
    })
    .catch((error) => {
      console.error("Public gateway failed to start", error);
      process.exit(1);
    });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      process.exit(0);
    });
  }
}
