# Docker Compose Configurator

::: tip 4.0 Multi-Source
This configurator sets up your **first / primary node only**. The `MESHTASTIC_NODE_IP` / `MESHTASTIC_TCP_PORT` values seed MeshMonitor's first source on initial boot.

- **Add more Meshtastic nodes** — once running, use **Dashboard → Sources → Add Source** in the UI. No container restart, no compose edits.
- **Virtual Node** — enable per-source from **Dashboard → Edit Source → Virtual Node**.
- **Additional bridges or sidecars** (extra BLE Bridge, extra Serial Bridge, a second MQTT Proxy, etc.) — the configurator publishes **one** of each. If you need a second instance for a second node, you'll need to hand-edit the generated `docker-compose.yml` to add another bridge/sidecar service with its own container name, device mapping, and port.

See [Multi-Source](/features/multi-source) for the full source model.
:::

<DockerComposeConfigurator />

## Need Help?

If you encounter any issues with your configuration:

- **Connection issues**: See our [troubleshooting guides](/getting-started#troubleshooting)
- **BLE setup**: Check the [BLE Bridge documentation](/configuration/ble-bridge)
- **Serial/USB setup**: Check the [Serial Bridge documentation](/configuration/serial-bridge)
- **MQTT Proxy setup**: Check the [MQTT Client Proxy documentation](/add-ons/mqtt-proxy)
- **Production deployment**: Review the [Production Deployment guide](/configuration/production)
- **Reverse proxy**: See [Reverse Proxy Configuration](/configuration/reverse-proxy)

## What's Next?

After deploying with the generated configuration:

1. **Configure your node**: Make sure your Meshtastic device is properly configured
2. **Set up notifications**: Configure [push notifications](/features/notifications) for alerts
3. **Security**: Review [security best practices](/configuration/production#security-hardening)
4. **Backups**: Set up [automated backups](/configuration/production#backups)
5. **Monitoring**: Configure [health checks and monitoring](/configuration/production#monitoring)

## Configuration Options Explained

### Connection Types

- **TCP/Network**: For devices with WiFi or Ethernet connectivity. This is the most straightforward option and provides the best performance.
- **Bluetooth (BLE)**: For devices that only have Bluetooth connectivity. Requires the BLE Bridge and a system with Bluetooth hardware.
- **USB/Serial**: For devices connected via USB or serial port. Requires the Serial Bridge and the device to be physically connected to your server.

### Deployment Modes

- **Development (HTTP)**: Best for local testing and home use. Simple HTTP access without SSL/TLS.
- **Production with Reverse Proxy**: Recommended for production deployments. Uses HTTPS via a reverse proxy like nginx, Caddy, or Traefik.
- **Production without Reverse Proxy**: Direct HTTP access in production. Not recommended due to lack of encryption.

### Security Options

- **Plan to use Virtual Node**: Publishes a host port so mobile apps (and the optional MQTT Proxy) can reach MeshMonitor's Virtual Node once you enable it. In 4.0 the Virtual Node is a **per-source** setting — enable it and choose an in-container port in **Dashboard → Edit Source → Virtual Node** after startup. The legacy `ENABLE_VIRTUAL_NODE` / `VIRTUAL_NODE_PORT` / `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` environment variables were removed.
- **Disable Anonymous Access**: When enabled, users must authenticate before accessing MeshMonitor. Useful for deployments accessible from the internet.

### Additional Settings

- **Automatic Self-Upgrade**: Enable one-click upgrades through the web UI with the upgrade watchdog sidecar.
- **Offline Map Tiles**: Add TileServer GL for serving offline map tiles when internet connectivity is limited.
- **Auto Responder Scripts**: Mount a scripts directory for custom automation scripts.
- **MQTT Client Proxy**: Route MQTT traffic through MeshMonitor instead of your node's WiFi. Useful for nodes with unreliable connectivity or when using Serial/BLE connections. See [MQTT Client Proxy documentation](/add-ons/mqtt-proxy).

## Advanced Topics

For more complex deployments, check out these resources:

- [Kubernetes/Helm Deployment](/configuration/production#kubernetes-with-helm-enterprise-scale)
- [High Availability Setup](/configuration/production#high-availability)
- [SSO/OIDC Authentication](/configuration/sso)
- [Custom SSL Certificates](/configuration/reverse-proxy)
- [Database Optimization](/configuration/production#database-optimization)
- [MQTT Client Proxy](/add-ons/mqtt-proxy) - Reliable MQTT for nodes with unreliable WiFi
