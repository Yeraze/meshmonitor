#!/bin/sh
set -e

# Start meshtastic-websocket-proxy in the background using npx
echo "Starting meshtastic-websocket-proxy..."
npx @liamcottle/meshtastic-websocket-proxy \
  --meshtastic-host="${MESHTASTIC_NODE_IP:-192.168.1.100}" \
  --websocket-port=8080 > /tmp/proxy.log 2>&1 &

PROXY_PID=$!

# Wait for proxy to be ready (check if port 8080 is listening)
echo "Waiting for proxy to be ready..."
for i in $(seq 1 120); do
  if nc -z localhost 8080 2>/dev/null; then
    echo "Proxy is ready!"
    break
  fi
  if [ $i -eq 120 ]; then
    echo "Proxy failed to start within 120 seconds"
    echo "=== Proxy log ==="
    cat /tmp/proxy.log
    exit 1
  fi
  sleep 1
done

# Start MeshMonitor server
echo "Starting MeshMonitor server..."
exec npm start
