#!/bin/bash
# Post-create script for MeshMonitor DevContainer
# Runs once when the container is first created

set -e

echo "=========================================="
echo "  MeshMonitor DevContainer Setup"
echo "=========================================="
echo ""

# Step 0: Configure Git (no .gitconfig mounted to avoid Windows locking issues)
echo "0. Configuring Git..."

# Configure safe.directory (required for mounted volumes from Windows)
git config --global --add safe.directory /workspace 2>&1
if [ $? -eq 0 ]; then
    echo "   ✓ Git safe.directory configured"
else
    EXIT_CODE=$?
    echo "   ⚠ Failed to configure Git safe.directory (exit code: $EXIT_CODE)"
fi

# Set basic git config if not already set (user can override later)
if ! git config --global user.name >/dev/null 2>&1; then
    git config --global user.name "Developer" 2>&1
    echo "   ℹ Set default git user.name (override with: git config --global user.name 'Your Name')"
fi

if ! git config --global user.email >/dev/null 2>&1; then
    git config --global user.email "developer@localhost" 2>&1
    echo "   ℹ Set default git user.email (override with: git config --global user.email 'you@example.com')"
fi

echo ""

# Step 1: Initialize git submodules (CRITICAL for protobuf definitions)
echo "1. Initializing git submodules..."
git submodule update --init --recursive
echo "   ✓ Git submodules initialized successfully"

# Step 2: Verify protobufs exist
echo ""
echo "2. Verifying Meshtastic protobuf definitions..."
if [ -f "protobufs/meshtastic/mesh.proto" ]; then
    echo "   ✓ Protobuf files found"
else
    echo "   ✗ Protobuf files not found!"
    echo "   The protobufs submodule may not be initialized correctly."
    exit 1
fi

# Step 2.5: Ensure workspace directories exist
echo ""
echo "2.5. Setting up workspace directories..."

# Ensure common directories exist
for dir in /workspace/node_modules /workspace/dist /workspace/.vite /workspace/.tsc-cache; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir" 2>&1 || true
        echo "   ✓ Created $dir"
    fi
done

# Ensure cache folders exist
mkdir -p /root/.cache /root/.npm /root/.local 2>&1 || true

# Step 3: Install npm dependencies
echo ""
echo "3. Installing npm dependencies (this may take a few minutes)..."

# Skip Puppeteer browser downloads (not needed for development)
export PUPPETEER_SKIP_DOWNLOAD=true
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
echo "   ℹ Skipping Puppeteer browser downloads"

npm install
echo "   ✓ Dependencies installed successfully"

# Step 4: Auto-setup .env file if it doesn't exist
echo ""
echo "4. Setting up environment configuration..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "   ✓ Created .env from .env.example"
        echo "   ℹ Configure MESHTASTIC_NODE_IP in .env to connect to your node"
    else
        echo "   ⚠ .env.example not found, skipping .env creation"
    fi
else
    echo "   ℹ .env already exists, skipping"
fi

# Step 5: Set up git hooks (if any)
echo ""
echo "5. Checking for git hooks..."
if [ -d ".git/hooks" ]; then
    echo "   ✓ Git hooks directory exists"
else
    echo "   ⚠ No git hooks configured"
fi

# Step 6: Install Claude Code CLI (always, for in-container usage)
echo ""
echo "6. Installing Claude Code CLI..."
echo "   Installing @anthropic-ai/claude-code globally..."
# Install globally for convenience (npx requires network on each run)
# Safe because this is a containerized environment, no system conflicts
# Alternative: Use 'npx @anthropic-ai/claude-code' if preferred
if npm install -g @anthropic-ai/claude-code 2>/dev/null; then
    echo "   ✓ Claude Code CLI installed: $(claude --version 2>/dev/null || echo 'installed')"
    echo "   ℹ Run 'claude' to start - you'll be prompted to authenticate"
    echo "   Authentication options: OAuth (recommended) or API key"
else
    echo "   ⚠ Claude Code CLI installation failed"
    echo "   Install manually: npm install -g @anthropic-ai/claude-code"
fi

# Step 7: Playwright browsers (SKIPPED - install manually if needed)
# Playwright installation takes ~5-10 minutes and installs many system dependencies
# To install later: npx playwright install --with-deps

# Step 8: Display environment information
echo ""
echo "8. Environment information:"
echo "   Node.js: $(node --version)"
echo "   npm: $(npm --version)"
echo "   TypeScript: $(npx tsc --version)"
echo "   Docker: $(docker --version 2>/dev/null || echo 'Installing...')"
echo "   Claude CLI: $(claude --version 2>/dev/null || echo 'Not installed (optional)')"

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Run: npm run test:run    # Verify tests pass"
echo "  2. Run: npm run dev:full    # Start dev servers"
echo "  3. Open: http://localhost:5173"
echo ""
