# pairwire relay (Node), specs/03-relay.md. Build from the repository root:
#   docker build -f packages/relay-node/Dockerfile -t pairwire-relay .
# Run behind a TLS-terminating proxy; clients require wss://.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.build.json ./
COPY packages/core/package.json packages/core/
COPY packages/relay-node/package.json packages/relay-node/
COPY packages/relay-worker/package.json packages/relay-worker/
COPY packages/client/package.json packages/client/
RUN npm ci --ignore-scripts -w @pairwire/core -w @pairwire/relay-node --include-workspace-root
COPY packages/core packages/core
COPY packages/relay-node packages/relay-node
RUN npx tsc -b packages/relay-node/tsconfig.build.json

FROM node:20-alpine
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/relay-node/package.json packages/relay-node/
COPY packages/relay-worker/package.json packages/relay-worker/
COPY packages/client/package.json packages/client/
RUN npm ci --ignore-scripts --omit=dev -w @pairwire/relay-node && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/relay-node/dist packages/relay-node/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "packages/relay-node/dist/main.js"]
