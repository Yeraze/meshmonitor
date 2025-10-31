# Duplicate Encryption Keys

---

## ⚠️ SECURITY WARNING

**If you were sent here, it's because your Node is vulnerable to security issues.**

Your Meshtastic device is sharing an encryption key with other devices on the network. This means there is **no privacy** between you and those devices. This page will help you understand the problem and fix it.

---

## What are Duplicate Keys?

Duplicate keys occur when **multiple Meshtastic devices use the same encryption key**. While this might seem convenient for group communications, it creates serious security and privacy issues:

- **No Privacy Between Devices**: All devices with the same key can decrypt each other's "private" messages
- **Identity Confusion**: The network cannot distinguish between different devices using the same key
- **Impersonation Risk**: Anyone with the key can send messages appearing to come from any device
- **Message Attribution**: You cannot verify who actually sent a message

## Why This is a Problem

### Privacy Violation

When you share a key with other devices:
- **Direct Messages (DMs) aren't private**: Any device with the same key can read your "private" conversations
- **Location tracking**: All devices with the key can see each other's GPS coordinates
- **Telemetry exposure**: Battery levels, sensor data, and device status are visible to all

### Security Concerns

Duplicate keys undermine the security model:
- **No accountability**: Messages cannot be reliably attributed to a specific sender
- **Easy impersonation**: Anyone with the shared key can pretend to be anyone else using that key
- **Compromised trust**: One compromised device exposes all devices using the same key
- **Message injection**: Malicious actors with the key can inject false data or messages

### Real-World Scenarios

**Scenario 1: Copied Configuration**
- You set up a new device by copying settings from an existing one
- Both devices now use the same encryption key
- You think DMs to your friend are private, but the other device owner can read them all

**Scenario 2: Shared Channel Key as Primary**
- Multiple people set up their devices using the same tutorial or QR code
- All devices share the same primary encryption key
- None of the "private" messages are actually private

**Scenario 3: Family or Group Setup**
- You configure multiple devices for family members with the same key for convenience
- Each family member can see everyone else's messages, locations, and telemetry
- No privacy within the group

## The Meshtastic Encryption Model

Meshtastic uses **AES256 encryption** with Pre-Shared Keys (PSK):

1. **Each device should have a unique primary encryption key**
2. **Channels use separate keys** for group communications
3. **Direct messages** use the device's primary key
4. **Channel messages** use the channel-specific key

### How It Should Work

```
Device A (Key: ABC123...) ──[Encrypted with ABC123]──> Device B (Key: DEF456...)
                                                         ❌ Cannot decrypt

Device A (Channel Key: XYZ789...) ──[Encrypted with XYZ789]──> All Channel Members
                                                                 ✓ All can decrypt
```

### How It Breaks with Duplicate Keys

```
Device A (Key: ABC123...) ──[Encrypted with ABC123]──> Device B (Key: ABC123...)
                                                        ✓ Can decrypt "private" message

Device C (Key: ABC123...) ──> Can also decrypt both A and B's "private" messages!
```

## How MeshMonitor Detected This

MeshMonitor identifies duplicate keys by:

1. **Collecting public keys** from encrypted packets on the mesh
2. **Computing key hashes** to identify duplicates without storing the actual keys
3. **Grouping devices** that share the same encryption key
4. **Alerting administrators** when multiple devices use identical keys

This detection is **passive and privacy-respecting**:
- MeshMonitor does **not** decrypt your messages
- It only identifies that the same encryption is being used by multiple devices
- It does **not** store your actual encryption keys

## How to Fix This Issue

Each device must have its own **unique encryption key**. Follow the instructions for your platform:

### iOS App (Meshtastic App)

**For each device individually:**

1. **Open the Meshtastic iOS app**
2. **Connect to the device** via Bluetooth
3. **Navigate to Settings**
   - Tap the gear icon (⚙️) in the top right
4. **Go to Radio Configuration**
   - Tap "Radio Configuration"
   - Select "LoRa"
5. **Generate a Unique PSK**
   - Scroll to "PSK" field
   - **Tap "Generate Random"** button
   - This creates a unique key for this specific device
6. **Save the configuration**
   - Tap "Save" in the top right
   - Wait for the device to reboot
7. **Record the new key**
   - Save the key in your password manager
   - Or export the channel QR code for backup

**Repeat for each affected device** - each should get a different random key.

### Android App (Meshtastic App)

**For each device separately:**

1. **Open the Meshtastic Android app**
2. **Connect to the device** via Bluetooth or WiFi
3. **Access Settings**
   - Tap the ≡ menu icon
   - Select your device name
4. **Navigate to Radio Configuration**
   - Tap "Radio Config"
   - Select "LoRa"
5. **Create a Unique PSK**
   - Find the "PSK" setting
   - Tap "Random" to generate a unique secure key
   - **Do not reuse the same key across devices**
6. **Apply Changes**
   - Tap the checkmark or "Save"
   - Allow the device to reboot
7. **Export and backup the new key**
   - Use "Share" to generate a QR code
   - Save this QR code securely

**Important:** Generate a **different** random key for each device.

### Command Line Interface (CLI)

**For each device:**

```bash
# Connect to the first device
meshtastic --set lora.psk random

# Disconnect and connect to the second device
# Generate a DIFFERENT random key
meshtastic --set lora.psk random

# Repeat for each device
```

#### Verify Unique Keys

```bash
# Check the PSK on each device to ensure they're different
meshtastic --info | grep "PSK"

# Device 1 might show: PSK: "1PG07oxeNkVu3XQnM77wVqhM4u4T2TqLcvGZ8/8K2Xg="
# Device 2 should show: PSK: "kN9mL5xT8qWp2Zv7RyB3nJ6vC4sX1wE9aH8dG5fT0uY="
# (These should be DIFFERENT)
```

## Maintaining Communication After Fix

After giving each device a unique key, you'll need to manage communications:

### For Direct Messages (DMs)

#### Exchange Keys Securely
1. **Generate a channel URL** with your key
2. **Share via encrypted messaging** (Signal, WhatsApp, etc.)
3. **Recipient imports** your key as a channel or contact
4. **Bidirectional setup**: Each person needs the other's key

#### Using the Apps

**iOS:**
- Navigate to Channels → Add Channel
- Import from QR code or URL
- Name it after the contact (e.g., "Alice's Key")

**Android:**
- Tap "+" to add a channel
- Scan QR code or paste URL
- Label with contact name

### For Group Communications

Keep your **device primary keys unique**, but use **shared channel keys** for groups:

```bash
# Device primary key (unique per device)
meshtastic --set lora.psk random

# Group channel (same for all group members)
meshtastic --ch-add "Family Group"
meshtastic --ch-set psk "SharedGroupKey123==" --ch-index 1
```

**Best Practice:**
- **Primary/Default channel**: Unique key per device (for DMs)
- **Additional channels**: Shared keys for group communications
- **Never** use your primary key as a channel key shared with others

## Preventing Future Duplicate Keys

### When Setting Up New Devices

**DON'T:**
- ❌ Copy configuration from one device to another
- ❌ Use the same tutorial QR code for multiple devices
- ❌ Share your primary key with others
- ❌ Set all family devices to the same key "for convenience"

**DO:**
- ✅ Generate a new random key for each device
- ✅ Use unique keys for primary/default channels
- ✅ Share channel keys only for intended group communications
- ✅ Document which keys belong to which devices

### Documentation Best Practices

Maintain a secure record:

```
Device Inventory:
- Device 1 (Node #ABC123): Primary Key = [stored in password manager]
- Device 2 (Node #DEF456): Primary Key = [stored in password manager]

Shared Channels:
- Family Channel: Key = [stored in password manager], Members: Device 1, 2, 3
- Hiking Group: Key = [stored in password manager], Members: Device 1, 4, 5
```

## Verifying Your Fix

### 1. Check MeshMonitor Security Page

- Return to the Security page that sent you here
- Wait for the next automatic scan (typically every 24 hours)
- Or ask an admin to trigger a manual scan
- Your devices should no longer appear grouped together

### 2. Verify Keys are Different

```bash
# Device 1
meshtastic --port /dev/ttyUSB0 --info | grep PSK

# Device 2
meshtastic --port /dev/ttyUSB1 --info | grep PSK

# Keys should be completely different
```

### 3. Test Communications

- **Test DMs**: Verify direct messages work with the new unique keys
- **Test Channels**: Ensure group channels still function
- **Monitor**: Watch for any devices that can't communicate (may need key exchange)

## Understanding the Trade-offs

### Convenience vs. Security

**Shared Keys (Convenient but Insecure):**
- ✅ Easy to set up multiple devices
- ✅ Works immediately without key exchange
- ❌ No privacy between devices
- ❌ Cannot identify who sent what
- ❌ One compromised device = all compromised

**Unique Keys (Secure but Requires Management):**
- ✅ True privacy for direct messages
- ✅ Clear attribution of messages
- ✅ Isolated compromise (one device doesn't expose others)
- ❌ Requires key exchange for DMs
- ❌ More complex setup

### When Shared Keys Might Be Acceptable

In very limited scenarios, shared keys **on a secondary channel** might be acceptable:

- **Test networks**: Temporary test setups with no sensitive data
- **Public information broadcast**: One-way announcements to the public
- **Demonstration purposes**: Trade shows, meetups, education

**Never use shared keys for:**
- Personal devices
- Private communications
- Location sharing you want to keep private
- Any sensitive data transmission

## Additional Resources

### Official Documentation
- [Meshtastic Security Overview](https://meshtastic.org/docs/overview/encryption)
- [Channel Configuration](https://meshtastic.org/docs/configuration/radio/channels/)
- [Best Practices Guide](https://meshtastic.org/docs/faq/#q-how-do-i-share-my-configuration-with-others)

### Security Research
- [Meshtastic Encryption Implementation](https://github.com/meshtastic/firmware/blob/master/src/mesh/CryptoEngine.cpp)
- [Meshtastic Security Audit](https://github.com/meshtastic/firmware/discussions) (Community discussions)

### Key Management Tools
- [1Password](https://1password.com/) - Password manager for storing keys
- [Bitwarden](https://bitwarden.com/) - Open-source password manager
- [KeePassXC](https://keepassxc.org/) - Offline password manager

### Community Support
- [Meshtastic Discord](https://discord.gg/meshtastic)
- [Meshtastic Forum](https://meshtastic.discourse.group/)
- [GitHub Discussions](https://github.com/meshtastic/firmware/discussions)

## FAQ

**Q: I intentionally share a key with my spouse/family. Is that bad?**
A: Yes, even between trusted people. You have no privacy from each other - they can read all your "private" messages, see your location history, and access all your device data. Use unique primary keys and a shared channel for family communications instead.

**Q: Can't I just trust that the other person won't read my messages?**
A: Trust is good, but **cryptographic privacy** is better. Technical controls are more reliable than social agreements. Plus, if one device is lost or compromised, all devices with that key are exposed.

**Q: What if I have multiple devices for myself (backup radio, etc.)?**
A: Even your own devices should have unique keys. Use channels to communicate between your devices, or set up key exchanges. This isolates compromise and maintains proper message attribution.

**Q: How do I communicate with someone after we both change our keys?**
A: Exchange your new keys securely (via QR code in person, or through encrypted messaging). Import each other's keys as channels in your devices.

**Q: Will fixing this break my existing communications?**
A: Yes, temporarily. After changing keys, you'll need to coordinate with your contacts to exchange new keys. Plan this transition with your mesh community.

**Q: How does this compare to Signal or WhatsApp security?**
A: Signal and WhatsApp use per-session unique keys with forward secrecy. Meshtastic's PSK model is simpler but requires proper key management. Duplicate keys completely undermine the security model.

**Q: Can MeshMonitor see my messages?**
A: No. MeshMonitor only detects that multiple devices share the same encryption. It does not decrypt messages or store encryption keys.

---

**Last Updated:** October 2024
**MeshMonitor Version:** 2.12.1+
