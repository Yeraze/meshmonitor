# Firmware OTA Updates

MeshMonitor can update your Meshtastic node's firmware over Wi-Fi (OTA) without physical USB access. This page covers requirements, the update process, limitations, and troubleshooting.

::: warning Experimental Feature
OTA firmware updates are a new feature. While tested on supported hardware, unexpected issues can occur including nodes becoming temporarily unresponsive. Always ensure you have USB access to your node as a fallback recovery method. If you encounter problems, please [report a bug](https://github.com/Yeraze/meshmonitor/issues/new?labels=bug,firmware-ota&template=bug_report.md).
:::

## Requirements

Before using OTA updates, your setup must meet **all** of the following:

| Requirement | Details |
|---|---|
| **TCP connection** | MeshMonitor must be connected to the node via TCP/IP (direct Wi-Fi). Serial and BLE bridge connections **cannot** use OTA updates. |
| **ESP32 hardware** | Only ESP32 and ESP32-S3 boards are supported (e.g., Heltec V3/V4, T-Beam, RAK WisBlock, Station G2). nRF52 and RP2040 boards do not support Wi-Fi OTA. |
| **Wi-Fi enabled** | The node must be connected to your local network with a known, reachable IP address. |
| **Firmware >= 2.7.18** | The node must already be running firmware version 2.7.18 or later. Earlier versions do not support the OTA update command. |
| **OTA bootloader installed** | A one-time USB flash of the OTA bootloader partition is required before the first OTA update. See below. |
| **Admin access** | Only MeshMonitor administrators can initiate firmware updates. |
| **Docker/server deployment** | OTA updates are only available when running MeshMonitor via Docker or as a standalone server. The desktop app (Windows/macOS) does not currently support OTA updates. |

### Connection Type Limitation

OTA updates require a **direct TCP connection** between MeshMonitor and the node. This means:

- **Supported:** MeshMonitor connected via `MESHTASTIC_NODE_IP` (TCP/IP over Wi-Fi)
- **Not supported:** Serial connections (`/dev/ttyUSB0`, `COM3`, etc.)
- **Not supported:** BLE bridge connections

If you are using a serial or BLE bridge connection, you must update your node's firmware using the standard USB method or the [Meshtastic Web Flasher](https://flasher.meshtastic.org/).

## One-Time OTA Bootloader Setup

The OTA bootloader must be flashed **once via USB** before any Wi-Fi OTA update will work. This writes a small bootloader to a dedicated partition that enables the node to receive firmware over the network.

### What You Need

- A USB data cable connected to the node
- Python with `esptool` installed: `pip install esptool`
- The OTA bootloader binary from the [Meshtastic firmware release](https://github.com/meshtastic/firmware/releases)

### Identify Your Board Type

Download the latest firmware `.zip` from [Meshtastic Firmware Releases](https://github.com/meshtastic/firmware/releases) and extract it. Locate the appropriate OTA bootloader file:

| Board Type | Bootloader File | Flash Address |
|---|---|---|
| **ESP32-S3** (Heltec V3/V4, T-Beam Supreme, Station G2) | `mt-esp32s3-ota.bin` | `0x340000` |
| **ESP32** (T-Beam, T-Lora, Heltec V2) | `mt-esp32-ota.bin` | `0x260000` |

### Flash the Bootloader

**Linux / macOS:**
```bash
esptool.py --port /dev/ttyUSB0 --baud 460800 write_flash 0x340000 mt-esp32s3-ota.bin
```

**Windows:**
```powershell
python -m esptool --port COM3 --baud 460800 write_flash 0x340000 mt-esp32s3-ota.bin
```

Replace the port (`/dev/ttyUSB0` or `COM3`) with your actual serial port, and adjust the address and filename for your board type.

### Verify Success

The flash is successful when you see:
```
Hash of data verified.
Leaving...
Hard resetting via RTS pin...
```

The node will reboot and return to normal Meshtastic operation. You can now disconnect the USB cable. All future firmware updates can be done over Wi-Fi through MeshMonitor.

## The OTA Update Process

Once the prerequisites are met, updating firmware through MeshMonitor follows these steps:

1. **Select a version** — Choose a firmware version from the list in Configuration > Firmware Updates. Stable and alpha channels are available, or you can specify a custom URL.

2. **Preflight check** — MeshMonitor verifies your hardware is OTA-capable, identifies the correct firmware binary for your board, and checks version compatibility.

3. **Config backup** — Your node's configuration is automatically backed up before any changes are made. The backup is stored on the MeshMonitor server and can be restored later.

4. **Download & extract** — The firmware release is downloaded from GitHub and the correct binary for your board is identified from the archive.

5. **Flash** — The firmware is uploaded to your node over Wi-Fi. A progress bar shows the upload status. The node will reboot during this process.

6. **Reconnect** — After the update completes, MeshMonitor automatically disconnects and reconnects to the node, re-downloading all configuration data to reflect the new firmware version.

::: tip
The entire update process runs inside a modal dialog that prevents interaction with the rest of the UI. This protects the update from being interrupted. Only the Cancel and Done buttons within the dialog are active during the update.
:::

## After the Update

When you click **Done** after a successful update, MeshMonitor will:

- Fully disconnect from the node
- Reconnect from scratch
- Re-download all node configuration, channels, and module settings

The UI will briefly show a disconnected state (just like when MeshMonitor first starts up) while it re-establishes the connection. This ensures that all displayed data reflects the new firmware version.

## Config Backups & Restore

Every OTA update creates an automatic config backup. You can view and restore backups from the **Backup Management** section in Configuration > Firmware Updates. This is useful if an update changes settings unexpectedly.

## Troubleshooting

### "OTA bootloader has not been installed"

If MeshMonitor reports that the node rebooted before firmware could be transferred, the OTA bootloader is not installed. Connect via USB and follow the [bootloader setup](#one-time-ota-bootloader-setup) instructions above.

### First OTA attempt fails, second succeeds

Some users report that the first OTA attempt after installing the bootloader fails, but the second attempt works. If your first flash attempt fails, click **Retry Flash** in the update dialog.

### Flash times out or shows "Connection refused"

Ensure the node's Wi-Fi IP address is correct and reachable from the MeshMonitor server. Verify connectivity:
```bash
meshtastic --host <NODE_IP> --info
```

If the node recently rebooted, wait 30 seconds for it to reconnect to Wi-Fi before retrying.

### Node is unresponsive after update

If the node does not come back online after a firmware update:

1. Wait 2 minutes — the node may take time to boot with new firmware
2. Power cycle the node (unplug and replug power)
3. If still unresponsive, connect via USB and flash firmware manually using the [Meshtastic Web Flasher](https://flasher.meshtastic.org/)

Your config backup is still available in MeshMonitor and can be restored after recovering the node.

## Reporting Issues

OTA firmware updates are an actively developed feature. If you encounter any problems:

1. Note the exact error message shown in the update dialog
2. Check the MeshMonitor server logs for additional details (`docker compose logs meshmonitor`)
3. [Open an issue on GitHub](https://github.com/Yeraze/meshmonitor/issues/new?labels=bug,firmware-ota&template=bug_report.md) with:
   - Your hardware model
   - Current and target firmware versions
   - The error message or unexpected behavior
   - Server logs if available

## Supported Hardware

The following ESP32 boards have been tested with OTA updates:

| Board | Status |
|---|---|
| Heltec V3 (ESP32-S3) | Tested |
| Heltec V4 (ESP32-S3) | Expected to work |
| T-Beam Supreme (ESP32-S3) | Expected to work |
| Station G2 (ESP32-S3) | Expected to work |
| RAK WisBlock (nRF52) | Not supported (no Wi-Fi) |
| T-Echo (nRF52) | Not supported (no Wi-Fi) |
| RP2040-based boards | Not supported (no Wi-Fi) |

If you successfully use OTA updates on a board not listed here, please let us know so we can update this list.
