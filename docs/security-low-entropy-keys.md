# Low-Entropy Encryption Keys

---

## ⚠️ SECURITY WARNING

**If you were sent here, it's because your Node is vulnerable to security issues.**

Your Meshtastic device is using a weak encryption key that can be easily compromised. This page will help you understand the problem and fix it.

---

## What is a Low-Entropy Key?

A low-entropy encryption key is a cryptographic key that is **predictable** or **easily guessable**. In the context of Meshtastic devices, certain keys are known to be weak because they:

- Use simple, sequential, or repetitive patterns
- Were generated using flawed methods
- Are well-known "default" keys that are publicly documented

When your device uses one of these keys, an attacker can:
- **Decrypt all your messages** by simply trying known weak keys
- **Impersonate your device** on the mesh network
- **Send fake messages** appearing to come from you
- **Monitor your location** and communications

This is **not a theoretical risk** - these keys are publicly documented and trivial to exploit.

## The Meshtastic Low-Entropy Key Vulnerability

The Meshtastic project has identified specific encryption keys that are considered weak or compromised. These keys appear in:

- **Default configurations** on certain device batches
- **Firmware versions** with flawed key generation
- **Documentation examples** that users copied verbatim
- **Shared configurations** copied between devices

### Known Vulnerable Keys

The most common weak keys include:
- `AQ==` (base64 for 0x01) - The default "simple" key
- All-zero keys (`AAAAAAAAAAAAAAAAAAAAAA==`)
- Sequential patterns (0x01020304...)
- Keys derived from device ID without proper randomization

For a complete list of known weak keys, see the [Meshtastic Security Documentation](https://meshtastic.org/docs/configuration/radio/lora/#psk).

## Security Impact

**Critical:** Anyone with access to the mesh network can:
1. Listen to all your private communications
2. Track your device's location and movement patterns
3. Inject false messages into your conversations
4. Impersonate your device to other mesh users
5. Disrupt network operations

**This affects:**
- Direct messages (DMs)
- Channel messages if the channel uses the weak key
- Your location data
- Telemetry and status information

## How to Fix This Issue

::: warning Upgrade Firmware First
Before rotating your encryption keys, **upgrade your Meshtastic firmware to version 2.6.11 or later**. Earlier firmware versions may regenerate weak keys. See the [official security advisory](https://github.com/meshtastic/firmware/security/advisories/GHSA-gq7v-jr8c-mfr7) for details.
:::

You must **generate and configure a strong, random encryption key** for your device. Follow the instructions for your platform:

### iOS App (Meshtastic App)

1. **Open the Meshtastic iOS app**
2. **Connect to your device** via Bluetooth
3. **Navigate to Settings**
   - Tap the gear icon (⚙️) in the top right
4. **Go to Radio Configuration**
   - Tap "Radio Configuration"
   - Select "LoRa"
5. **Change the PSK (Pre-Shared Key)**
   - Scroll down to "PSK" field
   - **Tap "Generate Random"** button
   - The app will create a cryptographically secure random key
6. **Save the configuration**
   - Tap "Save" in the top right
   - Wait for the device to reboot

**Important:** After changing your key:
- Your device will **no longer receive messages encrypted with the old key**
- You must **share your new key** with contacts you want to communicate with
- For channels, all participants need to update to the new key

### Android App (Meshtastic App)

1. **Open the Meshtastic Android app**
2. **Connect to your device** via Bluetooth or WiFi
3. **Access Settings**
   - Tap the ≡ menu icon
   - Select your device name
4. **Navigate to Radio Configuration**
   - Tap "Radio Config"
   - Select "LoRa"
5. **Generate a New PSK**
   - Find the "PSK" setting
   - Tap "Random" to generate a secure key
   - Or manually enter a base64-encoded 256-bit key
6. **Apply Changes**
   - Tap the checkmark or "Save"
   - Allow the device to reboot

**Note:** The Android app can also scan QR codes to share keys securely with other users.

### Command Line Interface (CLI)

If you're using the Meshtastic Python CLI or other command-line tools:

#### Generate a Random Key

```bash
# Install the Meshtastic CLI if you haven't already
pip install meshtastic

# Connect to your device and generate a random key
meshtastic --set lora.psk random

# Or generate a specific random 256-bit key
meshtastic --set lora.psk $(openssl rand -base64 32)
```

#### For Channels

```bash
# Set PSK for a specific channel (e.g., channel 0)
meshtastic --ch-set psk random --ch-index 0

# For primary channel
meshtastic --ch-set psk random --ch-index 0
```

#### Manual Key Generation

If you want to generate a key manually:

```bash
# Generate a 256-bit random key (Linux/macOS)
openssl rand -base64 32

# Example output: "1PG07oxeNkVu3XQnM77wVqhM4u4T2TqLcvGZ8/8K2Xg="

# Apply it to your device
meshtastic --set lora.psk "1PG07oxeNkVu3XQnM77wVqhM4u4T2TqLcvGZ8/8K2Xg="
```

## Sharing Your New Key Securely

After generating a new key, you'll need to share it with people you want to communicate with:

### Via QR Code (Recommended)
1. Use the mobile app to display your channel QR code
2. Other users scan the QR code to import your settings
3. This is the **most secure** method

### Via URL
1. Generate a channel URL: `https://meshtastic.org/e/#...`
2. Share via secure messaging (Signal, WhatsApp, etc.)
3. Recipients import the URL in their app

### Manual Entry
1. Export your PSK as base64 text
2. Share via encrypted messaging
3. Recipients manually enter the PSK

**⚠️ Never share keys via:**
- Unencrypted email
- Public forums or social media
- SMS text messages
- Over the mesh network itself (until encryption is updated)

## Verifying Your Fix

After updating your key:

1. **Check MeshMonitor Security Page**
   - Return to the Security page that sent you here
   - Wait for the next automatic scan (runs every 24 hours)
   - Or ask an admin to trigger a manual scan
   - Your device should no longer appear in the "Low-Entropy Keys" list

2. **Test Communication**
   - Send a test message to a contact who has your new key
   - Verify they receive it correctly
   - Verify you can receive their replies

3. **Verify Key on Device**
   ```bash
   # Check your current PSK
   meshtastic --info
   # Look for "PSK" in the LoRa configuration section
   ```

## Additional Resources

### Security Advisories
- [GHSA-gq7v-jr8c-mfr7: Low-Entropy Key Vulnerability](https://github.com/meshtastic/firmware/security/advisories/GHSA-gq7v-jr8c-mfr7) - Official Meshtastic security advisory

### Official Documentation
- [Meshtastic Security Overview](https://meshtastic.org/docs/overview/encryption)
- [LoRa Configuration Guide](https://meshtastic.org/docs/configuration/radio/lora/)
- [Channel Configuration](https://meshtastic.org/docs/configuration/radio/channels/)

### Security Research
- [Meshtastic Encryption Implementation](https://github.com/meshtastic/firmware/blob/master/src/mesh/CryptoEngine.cpp)
- [CVE Database - Meshtastic](https://cve.mitre.org/) (search for "Meshtastic")

### Community Support
- [Meshtastic Discord](https://discord.gg/meshtastic)
- [Meshtastic Forum](https://meshtastic.discourse.group/)
- [GitHub Issues](https://github.com/meshtastic/firmware/issues)

## Why MeshMonitor Detected This

MeshMonitor uses a database of known weak keys derived from:

1. **Published Lists**: Keys documented in security advisories
2. **Default Values**: Factory default keys from various firmware versions
3. **Pattern Analysis**: Keys that follow predictable patterns
4. **Community Reports**: Keys reported as compromised

The detection happens by:
- Intercepting encrypted packets on the mesh
- Extracting the public key from the packet
- Comparing against the known-weak-key database
- Flagging matches as security issues

This detection is **passive** - MeshMonitor doesn't attempt to decrypt your messages or compromise your device. It simply identifies that you're using a publicly-known weak key.

## FAQ

**Q: Will changing my key affect my device's range or performance?**
A: No. The encryption key doesn't affect radio performance, only which devices can decrypt your messages.

**Q: Can I use the same key on multiple devices I own?**
A: Yes, but be aware that this creates a duplicate key situation (see the [Duplicate Keys documentation](./security-duplicate-keys.md)). For maximum security, use unique keys.

**Q: How often should I change my encryption key?**
A: Change it immediately if it's weak. For strong keys, rotation every 6-12 months is good practice, or immediately if you suspect compromise.

**Q: What if I forget my key?**
A: Store your key securely:
- Use a password manager (1Password, Bitwarden, etc.)
- Keep a secure backup of your channel QR code
- Document it in your network's secure documentation

**Q: Can I use a custom key instead of random?**
A: Yes, but ensure it's:
- At least 256 bits (32 bytes) of randomness
- Properly base64-encoded
- Generated from a cryptographically secure random source
- Never derived from predictable sources (dates, names, etc.)

---

**Last Updated:** October 2024
**MeshMonitor Version:** 2.12.1+
