#!/bin/bash
#
# MeshMonitor LXC Template Build Script
# Creates a Proxmox-compatible LXC container template
#
# Usage: ./build-lxc-template.sh [version]
#   version: Optional version tag (e.g., "2.19.4" or "latest")
#

set -e  # Exit on error
set -u  # Exit on undefined variable

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$SCRIPT_DIR/build}"
TEMPLATE_NAME="meshmonitor"
VERSION="${1:-latest}"
DEBIAN_RELEASE="bookworm"  # Debian 12
ARCH="amd64"

# Derived paths
ROOTFS_DIR="$BUILD_DIR/rootfs"
TEMPLATE_FILE="$BUILD_DIR/${TEMPLATE_NAME}-${VERSION}-${ARCH}.tar.gz"

echo "================================================"
echo "MeshMonitor LXC Template Builder"
echo "================================================"
echo "Version: $VERSION"
echo "Debian Release: $DEBIAN_RELEASE"
echo "Architecture: $ARCH"
echo "Build Directory: $BUILD_DIR"
echo "Output Template: $TEMPLATE_FILE"
echo "================================================"

# Clean up previous build
if [ -d "$BUILD_DIR" ]; then
    echo "Cleaning up previous build..."
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR"
mkdir -p "$ROOTFS_DIR"

# Check for required commands
for cmd in debootstrap tar; do
    if ! command -v $cmd &> /dev/null; then
        echo "ERROR: Required command '$cmd' not found"
        echo "Install with: sudo apt-get install $cmd"
        exit 1
    fi
done

# Check if running as root (required for debootstrap)
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root for debootstrap"
    echo "Run with: sudo ./build-lxc-template.sh $VERSION"
    exit 1
fi

echo ""
echo "Step 1: Creating base Debian system with debootstrap..."
debootstrap --arch="$ARCH" --variant=minbase "$DEBIAN_RELEASE" "$ROOTFS_DIR" http://deb.debian.org/debian/

echo ""
echo "Step 2: Configuring base system..."

# Configure apt sources
cat > "$ROOTFS_DIR/etc/apt/sources.list" << EOF
deb http://deb.debian.org/debian $DEBIAN_RELEASE main contrib non-free non-free-firmware
deb http://deb.debian.org/debian $DEBIAN_RELEASE-updates main contrib non-free non-free-firmware
deb http://security.debian.org/debian-security $DEBIAN_RELEASE-security main contrib non-free non-free-firmware
EOF

# Set hostname
echo "meshmonitor" > "$ROOTFS_DIR/etc/hostname"

# Configure hosts file
cat > "$ROOTFS_DIR/etc/hosts" << EOF
127.0.0.1 localhost
127.0.1.1 meshmonitor

# The following lines are desirable for IPv6 capable hosts
::1     localhost ip6-localhost ip6-loopback
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
EOF

# Disable unnecessary services for LXC
chroot "$ROOTFS_DIR" systemctl mask systemd-networkd-wait-online.service || true

echo ""
echo "Step 3: Installing system dependencies..."

# Update package index and install basic tools
chroot "$ROOTFS_DIR" apt-get update
chroot "$ROOTFS_DIR" apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    procps \
    locales \
    systemd \
    systemd-sysv

# Generate locale
echo "en_US.UTF-8 UTF-8" >> "$ROOTFS_DIR/etc/locale.gen"
chroot "$ROOTFS_DIR" locale-gen

echo ""
echo "Step 4: Installing Node.js 22..."

# Add NodeSource repository for Node.js 22
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | chroot "$ROOTFS_DIR" gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > "$ROOTFS_DIR/etc/apt/sources.list.d/nodesource.list"

chroot "$ROOTFS_DIR" apt-get update
chroot "$ROOTFS_DIR" apt-get install -y nodejs

# Verify Node.js installation
echo "Node.js version: $(chroot "$ROOTFS_DIR" node --version)"
echo "npm version: $(chroot "$ROOTFS_DIR" npm --version)"

echo ""
echo "Step 5: Installing Python 3 and dependencies..."

chroot "$ROOTFS_DIR" apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    python3-dev \
    libsqlite3-dev

echo ""
echo "Step 6: Building MeshMonitor application..."

# Build the application in the project root
cd "$PROJECT_ROOT"

echo "Installing npm dependencies..."
npm install

echo "Building React frontend..."
npm run build

echo "Building Express backend..."
npm run build:server

echo ""
echo "Step 7: Installing MeshMonitor into container..."

# Create application directory structure
mkdir -p "$ROOTFS_DIR/opt/meshmonitor"
mkdir -p "$ROOTFS_DIR/data/apprise-config"
mkdir -p "$ROOTFS_DIR/data/scripts"
mkdir -p "$ROOTFS_DIR/data/logs"
mkdir -p "$ROOTFS_DIR/etc/meshmonitor"

# Copy built application
echo "Copying built application files..."
cp -r "$PROJECT_ROOT/dist" "$ROOTFS_DIR/opt/meshmonitor/"
cp -r "$PROJECT_ROOT/node_modules" "$ROOTFS_DIR/opt/meshmonitor/"
cp -r "$PROJECT_ROOT/protobufs" "$ROOTFS_DIR/opt/meshmonitor/"
cp "$PROJECT_ROOT/package.json" "$ROOTFS_DIR/opt/meshmonitor/"
cp "$PROJECT_ROOT/package-lock.json" "$ROOTFS_DIR/opt/meshmonitor/"

# Copy Docker helper scripts (apprise-api.py and others)
mkdir -p "$ROOTFS_DIR/opt/meshmonitor/docker"
cp "$PROJECT_ROOT/docker/apprise-api.py" "$ROOTFS_DIR/opt/meshmonitor/docker/"
chmod +x "$ROOTFS_DIR/opt/meshmonitor/docker/apprise-api.py"

# Copy upgrade scripts (even though auto-upgrade won't work)
if [ -d "$PROJECT_ROOT/scripts" ]; then
    cp -r "$PROJECT_ROOT/scripts/"*.sh "$ROOTFS_DIR/data/scripts/" 2>/dev/null || true
fi

echo ""
echo "Step 8: Creating Python virtual environment for Apprise..."

chroot "$ROOTFS_DIR" python3 -m venv /opt/apprise-venv
chroot "$ROOTFS_DIR" /opt/apprise-venv/bin/pip install --no-cache-dir apprise "paho-mqtt<2.0"

echo ""
echo "Step 9: Creating meshmonitor user and setting permissions..."

# Create meshmonitor user (UID 1000 to match Docker)
chroot "$ROOTFS_DIR" useradd -u 1000 -m -s /bin/bash meshmonitor || true

# Set ownership
chroot "$ROOTFS_DIR" chown -R meshmonitor:meshmonitor /opt/meshmonitor
chroot "$ROOTFS_DIR" chown -R meshmonitor:meshmonitor /data
chroot "$ROOTFS_DIR" chown -R meshmonitor:meshmonitor /opt/apprise-venv

echo ""
echo "Step 10: Installing systemd service units..."

# Copy systemd service files
cp "$SCRIPT_DIR/systemd/meshmonitor.service" "$ROOTFS_DIR/etc/systemd/system/"
cp "$SCRIPT_DIR/systemd/meshmonitor-apprise.service" "$ROOTFS_DIR/etc/systemd/system/"

# Enable services
chroot "$ROOTFS_DIR" systemctl enable meshmonitor.service
chroot "$ROOTFS_DIR" systemctl enable meshmonitor-apprise.service

echo ""
echo "Step 11: Creating environment file template..."

cat > "$ROOTFS_DIR/etc/meshmonitor/meshmonitor.env.example" << 'EOF'
# MeshMonitor Configuration
# Copy this file to meshmonitor.env and configure

# Required: IP address of your Meshtastic node
MESHTASTIC_NODE_IP=192.168.1.100

# Optional: TCP port for Meshtastic node (default: 4403)
#MESHTASTIC_TCP_PORT=4403

# Optional: Enable TLS for Meshtastic connection
#MESHTASTIC_USE_TLS=false

# Optional: Database path (default: /data/meshmonitor.db)
#DATABASE_PATH=/data/meshmonitor.db

# Optional: Server port (default: 3001)
#PORT=3001

# Optional: Base URL for subfolder deployments
#BASE_URL=/

# Optional: Session secret (auto-generated if not set)
#SESSION_SECRET=your-secret-here

# Optional: CORS allowed origins (comma-separated)
#ALLOWED_ORIGINS=http://localhost:8080

# Optional: Enable virtual node for mobile apps
#ENABLE_VIRTUAL_NODE=false
#VIRTUAL_NODE_PORT=4404

# Optional: VAPID keys for web push notifications
#VAPID_PUBLIC_KEY=
#VAPID_PRIVATE_KEY=
#VAPID_SUBJECT=mailto:your@email.com

# Optional: OIDC/SSO configuration
#OIDC_ISSUER=
#OIDC_CLIENT_ID=
#OIDC_CLIENT_SECRET=
#OIDC_ALLOW_HTTP=false

# Optional: Access logging (for fail2ban)
#ACCESS_LOG_ENABLED=false
#ACCESS_LOG_PATH=/data/logs/access.log
#ACCESS_LOG_FORMAT=combined
EOF

# Create empty environment file
touch "$ROOTFS_DIR/etc/meshmonitor/meshmonitor.env"
chmod 600 "$ROOTFS_DIR/etc/meshmonitor/meshmonitor.env"
chroot "$ROOTFS_DIR" chown meshmonitor:meshmonitor /etc/meshmonitor/meshmonitor.env

echo ""
echo "Step 12: Cleaning up container..."

# Clean up apt cache
chroot "$ROOTFS_DIR" apt-get clean
rm -rf "$ROOTFS_DIR/var/lib/apt/lists/"*
rm -rf "$ROOTFS_DIR/tmp/"*
rm -rf "$ROOTFS_DIR/var/tmp/"*

# Remove any build artifacts
rm -rf "$ROOTFS_DIR/root/.npm"
rm -rf "$ROOTFS_DIR/root/.cache"

echo ""
echo "Step 13: Creating container metadata..."

# Create container metadata file for Proxmox
cat > "$BUILD_DIR/metadata.yaml" << EOF
architecture: $ARCH
creation_date: $(date +%s)
properties:
  description: MeshMonitor - Meshtastic network monitoring and management
  name: meshmonitor
  os: debian
  release: $DEBIAN_RELEASE
  version: $VERSION
EOF

echo ""
echo "Step 14: Packaging template..."

# Create tarball
cd "$ROOTFS_DIR"
tar czf "$TEMPLATE_FILE" .

cd "$BUILD_DIR"
echo ""
echo "================================================"
echo "Build Complete!"
echo "================================================"
echo "Template file: $TEMPLATE_FILE"
echo "Size: $(du -h "$TEMPLATE_FILE" | cut -f1)"
echo ""
echo "To use with Proxmox VE:"
echo "1. Upload to Proxmox: scp $TEMPLATE_FILE root@proxmox:/var/lib/vz/template/cache/"
echo "2. Create container from template in Proxmox web UI"
echo "3. Configure MESHTASTIC_NODE_IP in /etc/meshmonitor/meshmonitor.env"
echo "4. Start the container"
echo "================================================"

# Calculate SHA256 checksum
sha256sum "$TEMPLATE_FILE" > "$TEMPLATE_FILE.sha256"
echo "SHA256: $(cat "$TEMPLATE_FILE.sha256")"
