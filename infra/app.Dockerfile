ARG LORE_VERSION=0.14.0
ARG LORESERVER_DIGEST=sha256:6add6c1bf96c959b63a5faf395bd00c7e890a57aeea828e3a3b9febab6ce893b

FROM ghcr.io/epicgames/lore/loreserver:${LORE_VERSION}@${LORESERVER_DIGEST} AS lore

FROM node:24-bookworm-slim AS web-builder

RUN corepack enable
WORKDIR /build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sqlite-db/package.json packages/sqlite-db/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY scripts/version.mjs scripts/version.mjs
RUN pnpm install --frozen-lockfile --filter @lore-portal/web...

COPY packages packages
COPY apps/web apps/web
ENV API_INTERNAL_URL=http://127.0.0.1:4000
ENV APP_PUBLIC_URL=http://localhost:3000
RUN pnpm --filter @lore-portal/web build

FROM node:24-trixie-slim AS api-builder

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sqlite-db/package.json packages/sqlite-db/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @lore-portal/server...

COPY packages packages
COPY apps/server apps/server
RUN pnpm --filter @lore-portal/server build \
    && pnpm --filter @lore-portal/server deploy --prod --legacy /app-runtime \
    && rm -rf /app-runtime/src /app-runtime/tests \
      /app-runtime/tsconfig.json /app-runtime/scripts

FROM node:24-trixie-slim

ARG PORTAL_VERSION=1.1.7
ARG LORE_VERSION=0.14.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssl \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/install-lore.sh /tmp/install-lore.sh
RUN LORE_VERSION="$LORE_VERSION" \
      LORE_INSTALL_BINARIES=lore \
      LORE_INSTALL_DIR=/usr/local/bin \
      sh /tmp/install-lore.sh \
    && rm /tmp/install-lore.sh

WORKDIR /app
COPY --from=api-builder /app-runtime ./apps/server
COPY --from=web-builder /build/apps/web/.next/standalone /opt/web
COPY --from=web-builder /build/apps/web/.next/static /opt/web/apps/web/.next/static
COPY --from=web-builder /build/apps/web/public /opt/web/apps/web/public
COPY --from=lore /usr/local/bin/loreserver /usr/local/bin/loreserver
COPY infra/run-app.mjs /usr/local/bin/run-app.mjs
COPY scripts/public-gateway.mjs /usr/local/bin/public-gateway.mjs
COPY infra/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
COPY infra/sync-lore-version.sh /usr/local/bin/sync-lore-version
COPY infra/generate-certs.sh /usr/local/bin/generate-certs.sh
COPY infra/lore/config /usr/local/share/lore/config
COPY infra/runtime.env /usr/local/share/lore/runtime.env
COPY NOTICE /usr/local/share/yeomai-lore/NOTICE
RUN chmod 0755 \
      /usr/local/bin/docker-entrypoint \
      /usr/local/bin/sync-lore-version \
      /usr/local/bin/generate-certs.sh

ENV PORTAL_VERSION="${PORTAL_VERSION}"
ENV LORE_VERSION="${LORE_VERSION}"
LABEL org.opencontainers.image.title="Yeomai Lore"
LABEL org.opencontainers.image.version="${PORTAL_VERSION}"
LABEL org.opencontainers.image.licenses="MIT"

VOLUME ["/data", "/certs"]
# Internal Web, API, Lore, and registry ports stay private to the container.
EXPOSE 3000/tcp 3000/udp
CMD ["/usr/local/bin/docker-entrypoint"]
