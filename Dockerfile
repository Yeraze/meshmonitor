# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# Use npm install instead of npm ci to avoid optional dependency bug
# better-sqlite3 will download pre-built binaries for the target platform
# Use cache mount to speed up repeated builds
# --legacy-peer-deps needed for vitest peer dependency conflicts
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps

# Verify protobufs are present (fail fast if git submodule wasn't initialized)
# Copy protobufs first as they rarely change
COPY protobufs ./protobufs
RUN if [ ! -f "protobufs/meshtastic/mesh.proto" ]; then \
      echo "ERROR: Protobuf files not found! Git submodule may not be initialized."; \
      echo "Run: git submodule update --init --recursive"; \
      exit 1; \
    fi

# Copy config files and source needed for builds
COPY tsconfig.json tsconfig.server.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public

# Build the React application first (always for root, will be rewritten at runtime)
# Vite clears dist directory, so this must come before server build
RUN --mount=type=cache,target=/app/node_modules/.vite \
    npm run build

# Build the server last so it doesn't get overwritten by Vite
# TypeScript server build will add to dist directory without clearing it
RUN --mount=type=cache,target=/app/.tsc-cache \
    npm run build:server

# Production stage
FROM node:24-alpine

WORKDIR /app

# Install curl (for healthchecks), Python and dependencies for Apprise
# Create python symlink for user scripts that use #!/usr/bin/env python
RUN apk add --no-cache \
    curl \
    python3 \
    py3-pip \
    py3-requests \
    supervisor \
    su-exec \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && python3 -m venv /opt/apprise-venv \
    && /opt/apprise-venv/bin/pip install --no-cache-dir apprise "paho-mqtt<2.0" meshtastic meshcore \
    && ln -sf /opt/apprise-venv/bin/meshtastic /usr/local/bin/meshtastic \
    && ln -sf /usr/bin/python3 /usr/local/bin/python3

# Copy package files
COPY package*.json ./

# Copy node_modules from builder (includes compiled native modules)
COPY --from=builder /app/node_modules ./node_modules

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist

# Copy protobuf definitions needed by the server
COPY --from=builder /app/protobufs ./protobufs

# Fix ownership of dist directory for node user
RUN chown -R node:node ./dist

# Copy upgrade-related scripts into container
COPY scripts/upgrade-watchdog.sh /app/scripts/upgrade-watchdog.sh
COPY scripts/test-docker-socket.sh /app/scripts/test-docker-socket.sh
COPY scripts/meshcore-bridge.py /app/scripts/meshcore-bridge.py
RUN chmod +x /app/scripts/upgrade-watchdog.sh /app/scripts/test-docker-socket.sh /app/scripts/meshcore-bridge.py

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
EXPOSE 3001 8000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV APPRISE_CONFIG_DIR=/data/apprise-config
ENV APPRISE_STATEFUL_MODE=simple

# Use entrypoint to deploy scripts before starting supervisor
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Run supervisor to manage both processes
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
