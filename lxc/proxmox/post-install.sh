#!/bin/bash
#
# MeshMonitor LXC Post-Installation Script
# Run this inside the LXC container after deploying from template
#
# Usage: bash /opt/meshmonitor/post-install.sh
#

set -e

echo "========================================"
echo "MeshMonitor LXC Post-Installation Setup"
echo "========================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root"
    echo "Run with: sudo bash $0"
    exit 1
fi

# Ensure data directory exists with correct permissions
echo "Setting up data directory..."
mkdir -p /data/apprise-config
mkdir -p /data/scripts
mkdir -p /data/logs
chown -R meshmonitor:meshmonitor /data
chmod 755 /data

# Check if environment file exists
if [ ! -f /etc/meshmonitor/meshmonitor.env ]; then
    echo "Creating environment configuration file..."
    cp /etc/meshmonitor/meshmonitor.env.example /etc/meshmonitor/meshmonitor.env
    chown meshmonitor:meshmonitor /etc/meshmonitor/meshmonitor.env
    chmod 600 /etc/meshmonitor/meshmonitor.env
fi

echo ""
echo "Configuration Required:"
echo "----------------------"

# Prompt for Meshtastic node IP
read -p "Enter your Meshtastic node IP address (e.g., 192.168.1.100): " NODE_IP

if [ -n "$NODE_IP" ]; then
    # Check if the IP is already set in the file
    if grep -q "^MESHTASTIC_NODE_IP=" /etc/meshmonitor/meshmonitor.env; then
        # Update existing value
        sed -i "s/^MESHTASTIC_NODE_IP=.*/MESHTASTIC_NODE_IP=$NODE_IP/" /etc/meshmonitor/meshmonitor.env
    else
        # Add new value
        echo "MESHTASTIC_NODE_IP=$NODE_IP" >> /etc/meshmonitor/meshmonitor.env
    fi
    echo "Meshtastic node IP configured: $NODE_IP"
else
    echo "WARNING: No IP address provided. You must configure MESHTASTIC_NODE_IP manually."
    echo "Edit /etc/meshmonitor/meshmonitor.env and set MESHTASTIC_NODE_IP"
fi

echo ""
echo "Reloading systemd and enabling services..."
systemctl daemon-reload
systemctl enable meshmonitor.service
systemctl enable meshmonitor-apprise.service

echo ""
read -p "Start MeshMonitor services now? (y/n): " START_NOW

if [ "$START_NOW" = "y" ] || [ "$START_NOW" = "Y" ]; then
    echo "Starting services..."
    systemctl start meshmonitor.service
    systemctl start meshmonitor-apprise.service

    # Wait a moment for services to start
    sleep 3

    echo ""
    echo "Service Status:"
    echo "---------------"
    systemctl status meshmonitor.service --no-pager --lines=5
    echo ""
    systemctl status meshmonitor-apprise.service --no-pager --lines=5
fi

echo ""
echo "========================================"
echo "Installation Complete!"
echo "========================================"
echo ""
echo "Access Information:"
echo "  Web UI: http://$(hostname -I | awk '{print $1}'):8080"
echo "  (Port 3001 is proxied to 8080 by default)"
echo ""
echo "Configuration:"
echo "  Edit: /etc/meshmonitor/meshmonitor.env"
echo "  Example: /etc/meshmonitor/meshmonitor.env.example"
echo ""
echo "Service Management:"
echo "  Start:   systemctl start meshmonitor"
echo "  Stop:    systemctl stop meshmonitor"
echo "  Restart: systemctl restart meshmonitor"
echo "  Status:  systemctl status meshmonitor"
echo "  Logs:    journalctl -u meshmonitor -f"
echo ""
echo "Data Directory:"
echo "  Location: /data"
echo "  Database: /data/meshmonitor.db"
echo "  Backups:  /data/system-backups"
echo ""
echo "Limitations:"
echo "  - Auto-upgrade feature is NOT available in LXC"
echo "  - Manual updates required (download new template)"
echo "  - See documentation for update procedures"
echo ""
echo "Documentation:"
echo "  https://github.com/jeremiah-k/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md"
echo "========================================"
