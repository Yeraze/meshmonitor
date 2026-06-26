#!/bin/bash
#
# MeshMonitor LXC Post-Installation Setup
# Run once inside the container after first deploy:
#
#   bash /opt/meshmonitor/lxc/proxmox/post-install.sh
#

CONTAINER_IP=$(hostname -I | awk '{print $1}')

# Copy the documented env example to meshmonitor.env if not already configured,
# then uncomment and set ALLOWED_ORIGINS with the container's actual IP.
# This gives the operator a fully documented env file with the one critical
# setting already filled in — no blank file, no CORS errors on first access.
ENV_FILE="/etc/meshmonitor/meshmonitor.env"
ENV_EXAMPLE="/etc/meshmonitor/meshmonitor.env.example"

if [ ! -s "$ENV_FILE" ] && [ -f "$ENV_EXAMPLE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    chown meshmonitor:meshmonitor "$ENV_FILE"
    chmod 600 "$ENV_FILE"
fi

# Set ALLOWED_ORIGINS — uncomment if commented, update if already set
if grep -q "^#*ALLOWED_ORIGINS=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^#*ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=http://${CONTAINER_IP}:3001|" "$ENV_FILE"
else
    echo "ALLOWED_ORIGINS=http://${CONTAINER_IP}:3001" >> "$ENV_FILE"
fi

# Restart meshmonitor to pick up the new env file
systemctl restart meshmonitor 2>/dev/null || true

# Ensure /usr/local/bin is in PATH — missing from minimal Debian's default PATH.
# Required for meshmonitor-update to be callable directly after self-install.
if ! grep -q '/usr/local/bin' /root/.bashrc 2>/dev/null; then
    echo 'export PATH=/usr/local/bin:$PATH' >> /root/.bashrc
fi

echo "========================================"
echo "MeshMonitor is running!"
echo "========================================"
echo ""
echo "  Web UI:  http://${CONTAINER_IP}:3001"
echo "  Login:   admin / changeme"
echo "           (change your password immediately)"
echo ""
echo "  Configure your Meshtastic node via the web UI."
echo "  Go to Settings -> Node Connection."
echo ""
echo "Service Management:"
echo "  Status:  systemctl status meshmonitor"
echo "  Logs:    journalctl -u meshmonitor -f"
echo "  Restart: systemctl restart meshmonitor"
echo ""
echo "Updates:"
echo "  First run:  bash /opt/meshmonitor/lxc/meshmonitor-update"
echo "              (self-installs to /usr/local/bin)"
echo "  After that: meshmonitor-update -h or "
echo "              meshmonitor-update -s"
echo ""
echo "Docs: https://github.com/Yeraze/meshmonitor/blob/main/docs/deployment/PROXMOX_LXC_GUIDE.md"
echo "========================================"