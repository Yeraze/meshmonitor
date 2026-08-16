# Build stage
FROM node:24.15.0-alpine3.22 AS builder

WORKDIR /app

# Native-module build toolchain (builder stage only — never in the runtime image).
# Most native deps (better-sqlite3, bcrypt) download prebuilt binaries, but re2
# has no prebuilt for every target (notably Alpine/musl on arm), so node-gyp must
# be able to compile it from source. `build-base` (C/C++ compiler) is what's new
# here; `python3` is node-gyp's other requirement (also installed in the runtime
# stage, but the stages are independent). Also a fallback for any other native
# dep missing a prebuilt for the target arch. `linux-headers` is required by
# node-gyp for sources that include kernel headers (musl does not ship them with
# build-base, unlike glibc distros) — not currently exercised by the amd64/arm64
# builds, which resolve prebuilts, but it is what turns a source-compile
# fallback from "sometimes works" into "works".
RUN apk add --no-cache build-base python3 linux-headers

# Copy package files
COPY package*.json ./

# Install dependencies
# Use npm install instead of npm ci to avoid optional dependency bug
# better-sqlite3 will download pre-built binaries for the target platform
# Use cache mount to speed up repeated builds
# --legacy-peer-deps needed for vitest peer dependency conflicts
#
# PUPPETEER_SKIP_DOWNLOAD=true: puppeteer's npm postinstall downloads a Chrome
# binary. This image is built for linux/arm64 under QEMU emulation, where that
# postinstall crashes with SIGILL ("qemu: uncaught target signal 4") and takes
# the whole build with it. Puppeteer is a devDependency used only by two ad-hoc
# screenshot helpers (scripts/capture-*-screenshots.js) — neither the runtime
# image nor the build needs the browser binary.
#
# .npmrc already sets `puppeteer_skip_download=true`, but that is no longer
# sufficient: npm now reports it as `Unknown project config` and stops
# forwarding it as `npm_config_puppeteer_skip_download`, so puppeteer never
# sees it and runs the download anyway. The environment variable is read
# directly by puppeteer and does not depend on npm's config forwarding.
# Dockerfile.armv7 has always set it this way — which is why the armv7 leg
# kept building while this one broke (v4.14.2-rc1).
RUN --mount=type=cache,target=/root/.npm \
    PUPPETEER_SKIP_DOWNLOAD=true \
    npm install --legacy-peer-deps

# Verify protobufs are present (fail fast if git submodule wasn't initialized)
# Copy protobufs first as they rarely change
COPY protobufs ./protobufs
RUN if [ ! -f "protobufs/meshtastic/mesh.proto" ]; then \
      echo "ERROR: Protobuf files not found! Git submodule may not be initialized."; \
      echo "Run: git submodule update --init --recursive"; \
      exit 1; \
    fi

# ATAK V2 zstd dictionaries (#4317) — runtime data files from the
# takpacket-sdk git submodule; only the dictionaries directory is needed
COPY takpacket-sdk/dictionaries ./takpacket-sdk/dictionaries
RUN if [ ! -f "takpacket-sdk/dictionaries/dict_non_aircraft.zstd" ]; then \
      echo "ERROR: TAKPacket-SDK dictionaries not found! Git submodule may not be initialized."; \
      echo "Run: git submodule update --init --recursive"; \
      exit 1; \
    fi

# Copy config files and source needed for builds
COPY tsconfig.json tsconfig.server.json tsconfig.node.json vite.config.ts index.html embed.html ./
COPY src ./src
COPY public ./public

# Build the React application first (always for root, will be rewritten at runtime)
# Vite clears dist directory, so this must come before server build
RUN --mount=type=cache,target=/app/node_modules/.vite \
    npm run build

# Build the server last so it doesn't get overwritten by Vite
# TypeScript server build will add to dist directory without clearing it
RUN npm run build:server

# Production stage
FROM node:24.15.0-alpine3.22

WORKDIR /app

# Install curl (for healthchecks), Python and dependencies for Apprise
# Create python symlink for user scripts that use #!/usr/bin/env python
RUN apk add --no-cache \
    curl \
    tzdata \
    unzip \
    python3 \
    py3-pip \
    py3-requests \
    supervisor \
    su-exec \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && python3 -m venv /opt/apprise-venv \
    && /opt/apprise-venv/bin/pip install --no-cache-dir apprise "paho-mqtt<2.0" meshtastic meshcore-cli \
    && ln -sf /opt/apprise-venv/bin/meshtastic /usr/local/bin/meshtastic \
    && ln -sf /opt/apprise-venv/bin/meshcore-cli /usr/local/bin/meshcore-cli \
    && ln -sf /opt/apprise-venv/bin/meshcli /usr/local/bin/meshcli \
    && ln -sf /usr/bin/python3 /usr/local/bin/python3

# Copy package files
COPY package*.json ./

# Copy node_modules from builder (includes compiled native modules)
COPY --from=builder /app/node_modules ./node_modules

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist

# Copy protobuf definitions needed by the server
COPY --from=builder /app/protobufs ./protobufs

# Copy ATAK V2 zstd dictionaries needed by the server (#4317) — dictionaries
# only; the rest of the submodule (testdata, docs, language bindings) is not
# needed at runtime
COPY --from=builder /app/takpacket-sdk/dictionaries ./takpacket-sdk/dictionaries

# Fix ownership of dist directory for node user
RUN chown -R node:node ./dist

# Copy admin password reset script
COPY reset-admin.mjs /app/reset-admin.mjs

# Create data directory for SQLite database and Apprise configs
RUN mkdir -p /data/apprise-config /data/scripts && chown -R node:node /data

# Create supervisor configuration to run both Node.js and Apprise
RUN mkdir -p /etc/supervisor/conf.d
COPY docker/supervisord.conf /etc/supervisord.conf

# Create Apprise API wrapper script
COPY docker/apprise-api.py /app/apprise-api.py
RUN chmod +x /app/apprise-api.py

# Copy and set up entrypoint script
COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose ports
# 3001: MeshMonitor Express server
# 8000: Internal Apprise API (not exposed to host by default)
# 8088: ATAK/CoT feed (settings-gated, default off — see docs/features/atak.md)
EXPOSE 3001 8000 8088

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV APPRISE_CONFIG_DIR=/data/apprise-config
ENV APPRISE_STATEFUL_MODE=simple

# Use entrypoint to deploy scripts before starting supervisor
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run supervisor to manage both processes
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
