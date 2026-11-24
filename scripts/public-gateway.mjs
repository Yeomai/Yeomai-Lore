import dgram from "node:dgram";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

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
  const secure = Boolean(config.tlsCertFile);
  const state = {
    publicServer: null,
    webServer: null,
    loreServer: null,
    loreSession: null,
    udpSocket: null,
    udpSessions: new Map(),
    tlsWatchTargets: [],
    tlsReloadTimer: null,
    pushQueue: Promise.resolve(),
    closed: false,
  };

  let publicServer;
  if (secure) {
    publicServer = createSecureServer(config, state);
  } else {
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

    publicServer = net.createServer({ pauseOnConnect: true }, (socket) => {
      proxyTransport(
        socket,
        webServer.address().port,
        loreServer.address().port,
        config,
      );
    });
  }
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
  if (secure) {
    watchTlsCertificate(publicServer, config, state);
  }

  return {
    port: publicPort,
    secure,
    close: () => closeGateway(state),
  };
}

function createSecureServer(config, state) {
  const server = http2.createSecureServer(
    {
      allowHTTP1: true,
      cert: readFileSync(config.tlsCertFile),
      key: readFileSync(config.tlsKeyFile),
      settings: { enablePush: false },
    },
    (request, response) => {
      if (isGrpcRequest(request)) {
        proxyGrpc(request, response, config, state);
      } else if (request.httpVersionMajor === 1) {
        proxyHttp1ToWeb(request, response, config);
      } else {
        proxyHttp2ToWeb(request, response, config);
      }
    },
  );
  server.on("upgrade", (request, socket, head) => {
    proxyWebSocket(request, socket, head, config);
  });
  server.on("clientError", (error, socket) => {
    console.error("public gateway web client error", error.message);
    socket.destroy();
  });
  server.on("sessionError", (error) => {
    console.error("public gateway HTTP/2 session error", error.message);
  });
  server.on("tlsClientError", (error) => {
    if (!state.closed) {
      console.error("public gateway TLS client error", error.message);
    }
  });
  return server;
}

function watchTlsCertificate(server, config, state) {
  const reload = () => {
    clearTimeout(state.tlsReloadTimer);
    state.tlsReloadTimer = setTimeout(() => {
      try {
        server.setSecureContext({
          cert: readFileSync(config.tlsCertFile),
          key: readFileSync(config.tlsKeyFile),
        });
        console.log("Public gateway TLS certificate reloaded");
      } catch (error) {
        console.error(
          "Public gateway TLS certificate reload failed",
          error.message,
        );
      }
    }, 250);
  };
  state.tlsWatchTargets = [config.tlsCertFile, config.tlsKeyFile];
  for (const file of state.tlsWatchTargets) {
    watchFile(file, { interval: 1_000 }, reload);
  }
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
  const tlsCertFile =
    options.tlsCertFile ?? process.env.PUBLIC_GATEWAY_TLS_CERT_FILE;
  const tlsKeyFile =
    options.tlsKeyFile ?? process.env.PUBLIC_GATEWAY_TLS_KEY_FILE;
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error(
      "PUBLIC_GATEWAY_TLS_CERT_FILE and PUBLIC_GATEWAY_TLS_KEY_FILE must be set together",
    );
  }
  const api = endpoint(
    options.apiInternalUrl ?? process.env.API_INTERNAL_URL,
    "127.0.0.1",
    4000,
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
    api,
    lore,
    quic,
    tlsCertFile,
    tlsKeyFile,
    pushCheckSecretFile:
      options.pushCheckSecretFile ??
      process.env.INTERNAL_GATEWAY_SECRET_FILE ??
      "data/local/run/gateway-internal-secret",
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
  if (config.tlsCertFile) headers["x-forwarded-proto"] = "https";
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
  if (config.tlsCertFile) headers["x-forwarded-proto"] = "https";
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
  if (isBranchPushRequest(request)) {
    void enqueueBranchPush(state, () =>
      proxyQuotaCheckedGrpc(request, response, config, state),
    ).catch((error) => {
      console.error("Branch push quota check failed", error);
      if (!response.headersSent && !response.destroyed) {
        respondGrpcError(response, 14, "Push authorization failed");
      }
    });
    return;
  }
  proxyGrpcToLore(request, response, config, state);
}

function proxyGrpcToLore(request, response, config, state) {
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

async function proxyQuotaCheckedGrpc(request, response, config, state) {
  const body = await readRequestBody(request, 1024 * 1024);
  const message = grpcMessage(body, headerValue(request.headers["grpc-encoding"]));
  const push = branchPushMessage(message);
  const authorization = headerValue(request.headers.authorization);
  if (!authorization) {
    respondGrpcError(response, 16, "Authorization is required");
    return;
  }

  let secret;
  try {
    secret = readFileSync(config.pushCheckSecretFile, "utf8").trim();
  } catch {
    respondGrpcError(response, 14, "Push authorization is unavailable");
    return;
  }

  const repositoryId = binaryHeaderBase64(
    request.headers["urc-repository-id-bin"],
  );
  let check;
  try {
    check = await fetch(
      `http://${config.api.host}:${config.api.port}/api/v1/internal/branch-push/check`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-yeomai-internal-secret": secret,
        },
        body: JSON.stringify({
          authorization,
          ...(repositoryId ? { repositoryId } : {}),
          branchId: push.branchId.toString("base64"),
          revisionSignature: push.revisionSignature.toString("hex"),
          force: push.force,
          fastForwardMerge: push.fastForwardMerge,
        }),
      },
    );
  } catch (error) {
    console.error("Push quota API unavailable", error);
    respondGrpcError(response, 14, "Push authorization is unavailable");
    return;
  }

  if (!check.ok) {
    const failure = await check.json().catch(() => ({}));
    const messageText =
      failure?.error?.message ??
      failure?.message ??
      "Repository storage quota exceeded";
    const status =
      check.status === 403
        ? 7
        : check.status === 404
          ? 5
          : check.status === 409
            ? 8
            : 14;
    respondGrpcError(response, status, messageText);
    return;
  }

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
    response.writeHead(
      Number(headers[":status"] ?? 502),
      transportHeaders(headers),
    );
  });
  upstream.on("data", (chunk) => {
    if (!response.write(chunk)) upstream.pause();
  });
  response.on("drain", () => upstream.resume());
  upstream.on("trailers", (trailers) => response.addTrailers(trailers));
  upstream.on("end", () => response.end());
  upstream.on("error", (error) => {
    if (!responded && !response.headersSent) {
      respondGrpcError(response, 14, "Lore upstream unavailable");
      return;
    }
    response.destroy(error);
  });
  upstream.end(body);
}

function enqueueBranchPush(state, work) {
  const current = state.pushQueue.then(work, work);
  state.pushQueue = current.catch(() => {});
  return current;
}

function isBranchPushRequest(request) {
  return (
    request.method === "POST" &&
    typeof request.url === "string" &&
    request.url.endsWith("/BranchPush") &&
    /^\/(?:lore\.revision\.v1\.RevisionService|urc\.rpc\.RevisionService)\/BranchPush$/.test(
      request.url,
    )
  );
}

function readRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("gRPC request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function grpcMessage(body, encoding) {
  if (body.length < 5) throw new Error("Invalid gRPC request frame");
  const compressed = body[0] === 1;
  if (body[0] !== 0 && !compressed) {
    throw new Error("Invalid gRPC compression flag");
  }
  const length = body.readUInt32BE(1);
  if (length !== body.length - 5) {
    throw new Error("Invalid gRPC request length");
  }
  const message = body.subarray(5);
  if (!compressed) return message;
  switch (String(encoding ?? "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(message);
    case "deflate":
      return inflateSync(message);
    case "br":
      return brotliDecompressSync(message);
    default:
      throw new Error("Unsupported gRPC compression");
  }
}

function branchPushMessage(message) {
  let offset = 0;
  let branchId = Buffer.alloc(0);
  let revisionSignature = Buffer.alloc(0);
  let force = false;
  let fastForwardMerge = false;
  while (offset < message.length) {
    const key = readVarint(message, offset);
    offset = key.offset;
    const field = key.value >>> 3;
    const wireType = key.value & 7;
    if (field === 1 || field === 2) {
      if (wireType !== 2) throw new Error("Invalid BranchPush message");
      const length = readVarint(message, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > message.length) throw new Error("Invalid BranchPush message");
      const value = message.subarray(offset, end);
      offset = end;
      if (field === 1) branchId = Buffer.from(value);
      if (field === 2) revisionSignature = Buffer.from(value);
      continue;
    }
    if (field === 3 || field === 4) {
      if (wireType !== 0) throw new Error("Invalid BranchPush message");
      const value = readVarint(message, offset);
      offset = value.offset;
      if (field === 3) force = value.value !== 0;
      if (field === 4) fastForwardMerge = value.value !== 0;
      continue;
    }
    offset = skipProtobufField(message, offset, wireType);
  }
  if (branchId.length !== 16 || revisionSignature.length !== 32) {
    throw new Error("Invalid BranchPush identifiers");
  }
  return { branchId, revisionSignature, force, fastForwardMerge };
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 10; index++) {
    if (offset >= buffer.length) throw new Error("Truncated protobuf varint");
    const byte = buffer[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("Invalid protobuf varint");
}

function skipProtobufField(buffer, offset, wireType) {
  if (wireType === 0) return readVarint(buffer, offset).offset;
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const length = readVarint(buffer, offset);
    return length.offset + length.value;
  }
  if (wireType === 5) return offset + 4;
  throw new Error("Unsupported protobuf wire type");
}

function headerValue(value) {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value === undefined ? "" : String(value);
}

function binaryHeaderBase64(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (Buffer.isBuffer(raw)) return raw.toString("base64");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("base64");
  return "";
}

function respondGrpcError(response, code, message) {
  if (response.destroyed || response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/grpc",
    "grpc-status": String(code),
    "grpc-message": encodeURIComponent(message),
  });
  response.end();
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
  clearTimeout(state.tlsReloadTimer);
  for (const file of state.tlsWatchTargets) {
    unwatchFile(file);
  }

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
    .then(({ port, secure }) => {
      console.log(
        `Public gateway listening on ${port}/TCP (${secure ? "https" : "http"}) and ${port}/UDP`,
      );
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
