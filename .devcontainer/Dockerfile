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
    && pip3 install --break-system-packages apprise \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Set up workspace directory
RUN mkdir -p /workspace

WORKDIR /workspace

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Default shell
ENV SHELL=/bin/bash

# Set entrypoint to fix permissions before running as node user
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default command (will be overridden by docker-compose)
CMD ["sleep", "infinity"]
