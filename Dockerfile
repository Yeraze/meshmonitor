# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with platform-specific handling
# Delete package-lock to force npm to resolve platform-specific deps
RUN rm -f package-lock.json && \
    npm install && \
    npm rebuild

# Copy source files
COPY . .

# Build the React application (always for root, will be rewritten at runtime)
RUN npm run build

# Build the server
RUN npm run build:server

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

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