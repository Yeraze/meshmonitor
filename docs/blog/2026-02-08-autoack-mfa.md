---
id: news-2026-02-08-autoack-mfa
title: MeshMonitor v3.4.8 - Auto-Acknowledge Settings & Two-Factor Authentication
date: '2026-02-08T18:00:00Z'
category: feature
priority: important
minVersion: 3.4.8
---
MeshMonitor v3.4.8 brings two major features: a comprehensive **Auto-Acknowledge** settings panel and **Two-Factor Authentication (MFA)** for account security.

## Auto-Acknowledge Settings

The new Auto-Acknowledge feature automatically responds to incoming messages that match a configurable pattern, making it ideal for network testing and mesh diagnostics.

### Key Capabilities

- **Regex Pattern Matching** - Define which messages trigger auto-responses (default: `^(test|ping)`)
- **Per-Channel Control** - Enable/disable on individual channels and direct messages
- **Separate Direct & Multi-Hop Templates** - Customize responses based on connection type
- **Dynamic Tokens** - Use `{SNR}`, `{RSSI}`, `{HOPS}`, `{LONG_NAME}`, `{TIME}`, and more in response templates
- **Tapback Reactions** - Optionally react with emoji based on hop count
- **Always DM Option** - Force responses via direct message even for channel triggers
- **Security** - Skip incomplete nodes that haven't sent full NODEINFO
- **Built-in Pattern Tester** - Validate your regex patterns with live preview before deploying

## Two-Factor Authentication (MFA)

Protect your MeshMonitor account with **TOTP-based two-factor authentication**.

### Setup

1. Navigate to **Settings > Security**
2. Click **Enable MFA** and scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)
3. Enter the verification code to confirm setup
4. Save your **backup codes** in a secure location

### How It Works

- After entering your password, you'll be prompted for a 6-digit code from your authenticator app
- **10 backup codes** are generated during setup for emergency access
- Each backup code can only be used once
- Administrators can disable MFA for other users if needed

[Read more about Auto-Acknowledge](https://meshmonitor.org/features/automation#auto-acknowledge)
