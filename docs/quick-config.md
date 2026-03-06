# Quick Node Configurator

<QuickNodeConfigurator />

## About

This tool configures Meshtastic nodes directly from your browser using the Web Serial API (USB) or Web Bluetooth API. No software installation required.

### Requirements

- **Browser:** Google Chrome or Microsoft Edge (desktop)
- **Connection:** USB cable to your Meshtastic device, or Bluetooth if your device supports BLE
- **Device:** Any Meshtastic-compatible radio

### Shareable Links

Community organizers can pre-fill settings and share a link so new members can configure their nodes with one click. Use the "Generate & Copy Shareable Link" button to create a URL with your community's settings.

Example: `https://meshmonitor.org/quick-config?region=US&preset=LONG_FAST&channel=MyMesh&role=CLIENT`

### Troubleshooting

- **"Browser Not Supported"** - Use Chrome or Edge on desktop. Firefox and Safari do not support Web Serial.
- **Device not appearing** - Make sure your device is connected via USB and powered on. Try a different USB cable.
- **Connection timeout** - The device must be in a ready state. Try power-cycling the device.
- **Write failed** - Ensure the device is still connected. Some operations may require the device to restart.

## Need Help?

- **General help**: See our [Getting Started guide](/getting-started)
- **Community support**: Join our [Discord](https://discord.gg/JVR3VBETQE)
