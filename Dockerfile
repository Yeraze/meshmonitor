# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
# Use npm install instead of npm ci to avoid optional dependency bug
# better-sqlite3 will download pre-built binaries for the target platform
RUN npm install

# Copy source files
COPY . .

# Verify protobufs are present (fail fast if git submodule wasn't initialized)
RUN if [ ! -f "protobufs/meshtastic/mesh.proto" ]; then \
      echo "ERROR: Protobuf files not found! Git submodule may not be initialized."; \
      echo "Run: git submodule update --init --recursive"; \
      exit 1; \
    fi

# Build the React application (always for root, will be rewritten at runtime)
RUN npm run build

# Build the server
RUN npm run build:server

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install Python and dependencies for Apprise
RUN apk add --no-cache \
    python3 \
    py3-pip \
    supervisor \
    su-exec \
    && python3 -m venv /opt/apprise-venv \
    && /opt/apprise-venv/bin/pip install --no-cache-dir apprise

# Copy package files
COPY package*.json ./

# Copy node_modules from builder (includes compiled native modules)
COPY --from=builder /app/node_modules ./node_modules

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist

# Copy protobuf definitions needed by the server
COPY --from=builder /app/protobufs ./protobufs

# Create data directory for SQLite database and Apprise configs
RUN mkdir -p /data/apprise-config && chown -R node:node /data

# Create supervisor configuration to run both Node.js and Apprise
RUN mkdir -p /etc/supervisor/conf.d
COPY docker/supervisord.conf /etc/supervisord.conf

# Create Apprise API wrapper script
COPY docker/apprise-api.py /app/apprise-api.py
RUN chmod +x /app/apprise-api.py

# Expose ports
# 3001: MeshMonitor Express server
# 8000: Internal Apprise API (not exposed to host by default)
EXPOSE 3001 8000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV APPRISE_CONFIG_DIR=/data/apprise-config
ENV APPRISE_STATEFUL_MODE=simple

# Run supervisor to manage both processes
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]