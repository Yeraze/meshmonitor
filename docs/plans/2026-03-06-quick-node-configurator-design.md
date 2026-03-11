# Quick Node Configurator - Design

**Date:** 2026-03-06
**Discussion:** #2126
**Status:** Approved

## Overview

A new VitePress page at `/quick-config` with a Vue component that lets users configure a Meshtastic node's basic settings via Web Serial (and optionally Web Bluetooth) directly from the browser. Community organizers can generate shareable URLs with pre-filled values to streamline new node onboarding.

## Problem

Communities struggle with configuring new nodes/users. Each new member needs to set the correct region, channel, LoRa preset, and other settings to join the mesh. Currently this requires using the Meshtastic app or CLI, which can be intimidating for non-technical users.

## Configuration Fields

| Field | Type | URL Param | Includable in Share Link |
|-------|------|-----------|--------------------------|
| Long Name | Text input | `longName` | Optional (checkbox) |
| Short Name | Text input (4 char max) | `shortName` | Optional (checkbox) |
| Private Key | Text input + Generate button | `key` | Optional (checkbox, default off) |
| Radio Role | Dropdown (Client, Client Mute, Router, etc.) | `role` | Always |
| Region | Dropdown (all Meshtastic regions) | `region` | Always |
| Channel Name | Text input | `channel` | Always |
| Channel PSK | Text input (base64) + Generate button | `psk` | Optional (checkbox, default off) |
| LoRa Preset | Dropdown (all 9 presets) | `preset` | Always |

### Radio Roles
- CLIENT
- CLIENT_MUTE
- CLIENT_HIDDEN
- TRACKER
- LOST_AND_FOUND
- SENSOR
- TAK
- TAK_TRACKER
- REPEATER
- ROUTER

### LoRa Presets
- Long Fast
- Long Moderate
- Long Slow
- Very Long Slow
- Medium Fast
- Medium Slow
- Short Fast
- Short Slow
- Short Turbo

### Regions
All Meshtastic-supported regions (US, EU_868, EU_433, CN, JP, ANZ, KR, TW, RU, IN, NZ_865, TH, LORA_24, UA_433, UA_868, MY_433, MY_919, SG_923, PH_433, PH_868, PH_915, etc.)

## Connection

- **Web Serial API** (primary) - Chrome/Edge, connect to USB-attached node
- **Web Bluetooth API** (optional/stretch goal) - Chrome, connect to BLE-enabled node
- Browser compatibility notice for unsupported browsers (Firefox, Safari)
- Uses `@meshtastic/js` npm package for protobuf communication with the device

## Share Link Feature

- "Generate Shareable Link" button at bottom of form
- Checkboxes next to sensitive fields (Long Name, Short Name, PSK, Private Key) control inclusion in the URL
- Non-sensitive fields (region, role, preset, channel name) are always included
- Link is copied to clipboard with a toast notification
- On page load, URL query params auto-populate the form fields
- Example: `meshmonitor.org/quick-config?region=US&role=CLIENT&channel=MyMesh&preset=LONG_FAST`

## Write Flow

1. User fills out form (or loads pre-filled values from URL params)
2. Clicks "Connect" - browser Serial/BLE device picker appears
3. Once connected, "Write to Device" button enables
4. Confirmation dialog: "This will overwrite the device's current configuration. Continue?"
5. Writes config to device
6. Shows success/error status

## UI/UX

- Same styling as existing DockerComposeConfigurator component
- Step-based layout: 1) Configure, 2) Connect, 3) Write
- "Write" button disabled until both config is valid and device is connected
- Private key and PSK fields have "Generate Random" buttons using browser `crypto.getRandomValues`
- Paste support for existing keys (base64 format)

## Technical Architecture

### Component Location
- Vue SFC: `docs/.vitepress/theme/QuickNodeConfigurator.vue`
- Page: `docs/quick-config.md`
- Registered in `docs/.vitepress/theme/index.ts`

### Dependencies
- `@meshtastic/js` - added as docs devDependency for protobuf communication
- Browser Web Serial API (no polyfill needed, graceful degradation)
- Browser Web Bluetooth API (optional, graceful degradation)
- Browser Web Crypto API for key generation

### No Backend Required
Entirely client-side. The VitePress static site communicates directly with the Meshtastic device through the browser's Serial/BLE APIs.

## Scope Decisions

- **Primary channel only** - no secondary channel configuration in v1
- **No current config reading** - just overwrite with confirmation dialog
- **No public key derivation** - would require Curve25519 dependency
- **BLE is stretch goal** - Serial is the primary connection method
