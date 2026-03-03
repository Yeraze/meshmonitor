# Firmware OTA Prerequisites

Wi-Fi Over-The-Air (OTA) firmware updates allow you to update your Meshtastic node's firmware without physical USB access. Before using MeshMonitor's OTA update feature, your node must meet the following prerequisites.

## Requirements

1. **ESP32-based hardware** — OTA updates are only supported on ESP32 and ESP32-S3 boards (e.g., Heltec V3/V4, T-Beam, RAK WisBlock)
2. **Wi-Fi enabled** — The node must be connected to your local Wi-Fi network with a known IP address
3. **Firmware >= 2.7.18** — The running firmware must support the `--ota-update` CLI command
4. **OTA bootloader installed** — A one-time USB flash of the OTA bootloader partition is required

## One-Time OTA Bootloader Setup

The OTA bootloader must be flashed **once via USB** before Wi-Fi OTA updates will work. This writes a small bootloader to the `ota_1` partition that enables the node to receive firmware over the network.

### What You Need

- A USB data cable connected to the node
- Python with `esptool` installed: `pip install esptool`
- The OTA bootloader file (`mt-esp32s3-ota.bin` or `mt-esp32-ota.bin`) from the [Meshtastic firmware release](https://github.com/meshtastic/firmware/releases)

### Flash the Bootloader

Download the latest firmware `.zip` from [Meshtastic Firmware Releases](https://github.com/meshtastic/firmware/releases) and extract it. Locate the appropriate OTA bootloader file:

- **ESP32-S3 boards** (Heltec V3/V4, T-Beam Supreme, etc.): `mt-esp32s3-ota.bin` at address `0x340000`
- **ESP32 boards** (T-Beam, T-Lora, etc.): `mt-esp32-ota.bin` at address `0x260000`

**Linux:**
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

The node will reboot and return to normal Meshtastic operation. You can now disconnect the USB cable — all future firmware updates can be done over Wi-Fi.

## Troubleshooting

### Node reboots immediately during OTA update

If the node reboots back to Meshtastic within ~15 seconds of starting an OTA update (without accepting the firmware), the OTA bootloader is likely not installed. Connect via USB and flash the bootloader as described above.

### First OTA attempt fails, second succeeds

Some users report that the first OTA attempt after installing the bootloader does nothing, but the second attempt works. If your first flash attempt fails, try clicking **Retry Flash** in the MeshMonitor wizard.

### Flash times out

Ensure the node's Wi-Fi IP address is correct and reachable from the MeshMonitor server. You can verify connectivity with:
```bash
meshtastic --host <NODE_IP> --info
```
