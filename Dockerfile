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

# Copy package files
COPY package*.json ./

# Copy node_modules from builder (includes compiled native modules)
COPY --from=builder /app/node_modules ./node_modules

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist

# Copy protobuf definitions needed by the server
COPY --from=builder /app/protobufs ./protobufs

# Create data directory for SQLite database
RUN mkdir -p /data && chown -R node:node /data

# Switch to non-root user
USER node

# Expose port 3001 (the Express server port)
EXPOSE 3001

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Start the Express server which serves both API and static files
CMD ["npm", "start"]