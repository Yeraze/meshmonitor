# Development container for MeshMonitor
# Based on Node.js 22 (required for project, Node 18 deprecated)
FROM mcr.microsoft.com/devcontainers/typescript-node:22

# Install additional dependencies
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
        git \
        python3 \
        python3-pip \
        python3-venv \
        sqlite3 \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Install Apprise for notification testing (optional)
RUN pip3 install --break-system-packages apprise || true

# Set up workspace
WORKDIR /workspace

# Use non-root user for security
USER node

# Default shell
ENV SHELL=/bin/bash
