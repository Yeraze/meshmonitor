# Multi-stage Dockerfile with optional protobuf fetch for reproducible builds
# Supports linux/amd64 and linux/arm64
# Build args:
#   - FETCH_PROTOBUF=1 : fetch Meshtastic protobufs during build if not in context

ARG NODE_VERSION=22-alpine

############################
# Builder
############################
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

# system deps for node-gyp and optional git
RUN apk add --no-cache python3 py3-pip make g++ bash git

# Copy package files & install deps first (better caching)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# Copy rest of the source
COPY . .

# Optionally fetch protobufs if not present in the build context
ARG FETCH_PROTOBUF=0
RUN if [ "$FETCH_PROTOBUF" = "1" ] && [ ! -f "protobufs/meshtastic/mesh.proto" ]; then \
      echo "Fetching Meshtastic protobufs..."; \
      mkdir -p protobufs && \
      git clone --depth=1 https://github.com/meshtastic/protobufs.git /tmp/meshtastic-protobufs && \
      mkdir -p protobufs/meshtastic && \
      cp -r /tmp/meshtastic-protobufs/meshtastic/* protobufs/meshtastic/ && \
      rm -rf /tmp/meshtastic-protobufs ; \
    else \
      echo "Using protobufs from context."; \
    fi

# Build
RUN npm run build

############################
# Runtime
############################
FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

# minimal runtime deps + supervisor for multiprocess
RUN apk add --no-cache supervisor su-exec

# Copy app artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/supervisord.conf ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/protobufs ./protobufs

# Production install (only prod deps)
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# Environment
ENV NODE_ENV=production \
    PORT=3001

EXPOSE 3001

# Default supervisor config expects "meshmonitor" program invoking node dist/server/server.js
CMD ["supervisord", "-c", "/app/supervisord.conf"]
