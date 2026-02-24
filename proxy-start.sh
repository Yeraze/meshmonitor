#!/bin/sh
set -e

# Start the proxy with npx (will download if needed)
npx @liamcottle/meshtastic-websocket-proxy "$@" &
PROXY_PID=$!

# Wait for port 8080 to be listening
for i in $(seq 1 180); do
  if nc -z localhost 8080 2>/dev/null; then
    echo "Proxy is ready on port 8080"
    touch /tmp/proxy-ready
    break
  fi
  sleep 1
done

# Wait for the proxy process
wait $PROXY_PID
