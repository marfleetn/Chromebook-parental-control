# syntax=docker/dockerfile:1
# CHPC — self-hosted parental control for family Chromebooks.
# Multi-stage: build the web console, then a slim runtime image that runs the
# Express API and serves the console. Runs as a non-root user.
#
#   docker build -t chpc .
#   docker run -p 4100:4100 -e CHPC_GUARDIAN_PIN=… -v chpc-data:/data chpc

FROM node:22-alpine AS build
WORKDIR /app

# 1) Install (workspaces: core, server, web)
COPY package.json package-lock.json ./
COPY core/package.json    core/
COPY server/package.json  server/
COPY web/package.json     web/
RUN npm ci --no-audit --no-fund

# 2) Build the React console -> web/dist
COPY core/   core/
COPY web/    web/
RUN npm run build:web && test -f web/dist/index.html

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100 \
    CHPC_DB=/data/chpc.db \
    CHPC_PUBLIC_DIR=/opt/chpc/public \
    CHPC_RETENTION_DAYS=90
WORKDIR /opt/chpc

# Runtime deps only (no devDependencies, no web build toolchain).
COPY package.json package-lock.json ./
COPY core/package.json    core/
COPY server/package.json  server/
COPY web/package.json     web/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# App code (server imports @chpc/core through the workspace link).
COPY core/src/   core/src/
COPY server/src/ server/src/

# Pre-built web console.
COPY --from=build /app/web/dist /opt/chpc/public

RUN mkdir -p /data && addgroup -S chpc && adduser -S -G chpc chpc \
    && chown -R chpc:chpc /data && chmod 700 /data
USER chpc

VOLUME ["/data"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
# CHPC_GUARDIAN_PIN must be supplied at run time; the server exits otherwise.
CMD ["node", "server/src/index.js"]
