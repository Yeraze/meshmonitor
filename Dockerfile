# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including native dependencies)
RUN npm ci

# Copy source files
COPY . .

# Build the React application
RUN npm run build

# Build the server
RUN npm run build:server

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy built assets from builder stage
COPY --from=builder /app/dist ./dist

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