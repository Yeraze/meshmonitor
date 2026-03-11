# Quick Node Configurator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a browser-based Quick Node Configurator page to the meshmonitor.org VitePress docs site that configures Meshtastic nodes via Web Serial/BLE with shareable URL parameters.

**Architecture:** Vue 3 SFC component registered in VitePress theme. Uses `@meshtastic/core` + `@meshtastic/transport-web-serial` + `@meshtastic/transport-web-bluetooth` for device communication. Protobuf messages created with `@bufbuild/protobuf` `create()` + `@meshtastic/protobufs` schemas. All client-side, no backend.

**Tech Stack:** Vue 3, VitePress, `@meshtastic/core@2.6.7`, `@meshtastic/transport-web-serial@0.2.5`, `@meshtastic/transport-web-bluetooth@0.1.5`, `@meshtastic/protobufs@2.7.18`, `@bufbuild/protobuf`

**Design Doc:** `docs/plans/2026-03-06-quick-node-configurator-design.md`

---

## Task 1: Install Dependencies

**Files:**
- Modify: `docs/package.json` (or root `package.json` if docs shares it)

**Step 1: Check if docs has its own package.json**

Run: `ls docs/package.json 2>/dev/null || echo "uses root"`

**Step 2: Install meshtastic packages as devDependencies**

```bash
npm install --save-dev @meshtastic/core@2.6.7 @meshtastic/transport-web-serial@0.2.5 @meshtastic/transport-web-bluetooth@0.1.5 @meshtastic/protobufs@2.7.18 @bufbuild/protobuf
```

Note: These only need to be available at docs build time (VitePress bundles them client-side).

**Step 3: Verify installation**

Run: `node -e "require('@meshtastic/core')" 2>&1 || echo "OK - ESM only, will work in VitePress"`

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @meshtastic/core and transport packages for Quick Node Configurator"
```

---

## Task 2: Create the Vue Component - Form UI

**Files:**
- Create: `docs/.vitepress/theme/QuickNodeConfigurator.vue`

**Step 1: Create the component with form UI (no device logic yet)**

This is a large component. Create it with the full form layout matching the existing `DockerComposeConfigurator.vue` styling patterns. The component should have:

- Reactive `config` object with all fields
- URL parameter loading on mount via `onMounted` + `URLSearchParams`
- Form validation computed property
- Share link generation with optional field inclusion

```vue
<template>
  <div class="configurator">
    <h2>Quick Node Configurator</h2>
    <p class="description">
      Configure your Meshtastic node directly from your browser using USB Serial or Bluetooth.
      Community organizers can generate shareable links with pre-filled settings.
    </p>

    <div v-if="!isSerialSupported && !isBleSupported" class="warning-box">
      <strong>Browser Not Supported</strong>
      <p>
        This tool requires Web Serial or Web Bluetooth API support.
        Please use <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on desktop.
      </p>
    </div>

    <!-- Step 1: Node Identity -->
    <section class="config-section">
      <h3>1. Node Identity</h3>

      <div class="form-group">
        <label for="longName">Long Name</label>
        <input
          id="longName"
          v-model="config.longName"
          type="text"
          placeholder="My Meshtastic Node"
          class="text-input"
          maxlength="40"
        />
        <p class="field-help">The full display name for this node (max 40 characters)</p>
      </div>

      <div class="form-group">
        <label for="shortName">Short Name</label>
        <input
          id="shortName"
          v-model="config.shortName"
          type="text"
          placeholder="MN"
          class="text-input"
          maxlength="4"
        />
        <p class="field-help">A short identifier shown on small displays (max 4 characters)</p>
      </div>

      <div class="form-group">
        <label for="privateKey">Private Key (Base64)</label>
        <div class="input-with-button">
          <input
            id="privateKey"
            v-model="config.privateKey"
            type="text"
            placeholder="Paste existing key or generate a new one"
            class="text-input"
          />
          <button @click="generatePrivateKey" class="action-btn small">Generate</button>
        </div>
        <p class="field-help">
          32-byte encryption key in Base64 format. Generate a random one or paste an existing key.
        </p>
      </div>
    </section>

    <!-- Step 2: Radio Settings -->
    <section class="config-section">
      <h3>2. Radio Settings</h3>

      <div class="form-group">
        <label for="role">Device Role</label>
        <select id="role" v-model="config.role" class="select-input">
          <option v-for="r in roles" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
        <p class="field-help">Determines how this node participates in the mesh network</p>
      </div>

      <div class="form-group">
        <label for="region">Region</label>
        <select id="region" v-model="config.region" class="select-input">
          <option v-for="r in regions" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
        <p class="field-help">Must match the regulatory region where this node operates</p>
      </div>

      <div class="form-group">
        <label for="preset">LoRa Preset</label>
        <select id="preset" v-model="config.preset" class="select-input">
          <option v-for="p in presets" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <p class="field-help">Determines range vs speed trade-off. All nodes on a mesh must use the same preset.</p>
      </div>
    </section>

    <!-- Step 3: Channel -->
    <section class="config-section">
      <h3>3. Primary Channel</h3>

      <div class="form-group">
        <label for="channelName">Channel Name</label>
        <input
          id="channelName"
          v-model="config.channelName"
          type="text"
          placeholder="LongFast"
          class="text-input"
          maxlength="12"
        />
        <p class="field-help">Name of the primary channel (max 12 characters). Leave empty for the default channel.</p>
      </div>

      <div class="form-group">
        <label for="channelPsk">Channel Key (Base64)</label>
        <div class="input-with-button">
          <input
            id="channelPsk"
            v-model="config.channelPsk"
            type="text"
            placeholder="AQ== (default key)"
            class="text-input"
          />
          <button @click="generateChannelPsk" class="action-btn small">Generate</button>
        </div>
        <p class="field-help">
          Pre-shared key for channel encryption. Use <code>AQ==</code> for the default key,
          or generate a random 256-bit key for a private channel.
        </p>
      </div>
    </section>

    <!-- Step 4: Share Link -->
    <section class="config-section">
      <h3>4. Shareable Link</h3>
      <p class="help-text">Generate a link with your settings pre-filled. Choose which fields to include:</p>

      <div class="checkbox-group">
        <label class="checkbox-option">
          <input type="checkbox" v-model="shareOptions.longName" />
          <span>Include Long Name</span>
        </label>
        <label class="checkbox-option">
          <input type="checkbox" v-model="shareOptions.shortName" />
          <span>Include Short Name</span>
        </label>
        <label class="checkbox-option">
          <input type="checkbox" v-model="shareOptions.privateKey" />
          <span>Include Private Key</span>
        </label>
        <label class="checkbox-option">
          <input type="checkbox" v-model="shareOptions.channelPsk" />
          <span>Include Channel Key</span>
        </label>
      </div>

      <div class="form-group" style="margin-top: 1rem;">
        <button @click="generateShareLink" class="action-btn">
          {{ copiedLink ? 'Copied to Clipboard!' : 'Generate & Copy Shareable Link' }}
        </button>
      </div>
    </section>

    <!-- Step 5: Connect & Write -->
    <section class="config-section">
      <h3>5. Connect & Write to Device</h3>

      <div class="form-group">
        <div class="connection-buttons">
          <button
            v-if="isSerialSupported"
            @click="connectSerial"
            :disabled="connectionStatus === 'connecting'"
            class="action-btn"
          >
            {{ connectionStatus === 'connected' && connectionType === 'serial' ? 'Serial Connected' : 'Connect via USB Serial' }}
          </button>
          <button
            v-if="isBleSupported"
            @click="connectBle"
            :disabled="connectionStatus === 'connecting'"
            class="action-btn"
          >
            {{ connectionStatus === 'connected' && connectionType === 'ble' ? 'BLE Connected' : 'Connect via Bluetooth' }}
          </button>
        </div>

        <p v-if="connectionStatus === 'connecting'" class="status-text connecting">
          Connecting to device...
        </p>
        <p v-if="connectionStatus === 'connected'" class="status-text connected">
          Connected via {{ connectionType === 'serial' ? 'USB Serial' : 'Bluetooth' }}
        </p>
        <p v-if="connectionStatus === 'error'" class="status-text error">
          {{ connectionError }}
        </p>
      </div>

      <div class="form-group" style="margin-top: 1rem;">
        <button
          @click="writeToDevice"
          :disabled="connectionStatus !== 'connected' || !isFormValid || isWriting"
          class="action-btn primary"
        >
          {{ isWriting ? 'Writing...' : 'Write Configuration to Device' }}
        </button>
      </div>

      <div v-if="writeStatus === 'success'" class="info-box success">
        <strong>Configuration written successfully!</strong>
        <p>Your device will restart with the new settings. You may need to reconnect.</p>
      </div>
      <div v-if="writeStatus === 'error'" class="info-box error">
        <strong>Failed to write configuration</strong>
        <p>{{ writeError }}</p>
      </div>
    </section>

    <!-- Confirmation Dialog -->
    <div v-if="showConfirmDialog" class="modal-overlay" @click.self="showConfirmDialog = false">
      <div class="modal-dialog">
        <h3>Confirm Configuration Write</h3>
        <p>This will overwrite the device's current configuration with the settings above. The device will restart after writing.</p>
        <p><strong>Are you sure you want to continue?</strong></p>
        <div class="modal-actions">
          <button @click="showConfirmDialog = false" class="action-btn">Cancel</button>
          <button @click="confirmWrite" class="action-btn primary">Write Configuration</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

// ---- Config State ----
const config = ref({
  longName: '',
  shortName: '',
  privateKey: '',
  role: 'CLIENT',
  region: 'US',
  preset: 'LONG_FAST',
  channelName: '',
  channelPsk: 'AQ==',
})

const shareOptions = ref({
  longName: false,
  shortName: false,
  privateKey: false,
  channelPsk: false,
})

// ---- Connection State ----
const connectionStatus = ref('disconnected') // disconnected | connecting | connected | error
const connectionType = ref(null) // 'serial' | 'ble'
const connectionError = ref('')
const meshDevice = ref(null)

// ---- Write State ----
const isWriting = ref(false)
const writeStatus = ref(null) // null | 'success' | 'error'
const writeError = ref('')
const showConfirmDialog = ref(false)

// ---- UI State ----
const copiedLink = ref(false)

// ---- Browser Support Detection ----
const isSerialSupported = ref(false)
const isBleSupported = ref(false)

onMounted(() => {
  isSerialSupported.value = 'serial' in navigator
  isBleSupported.value = 'bluetooth' in navigator

  // Load URL parameters
  loadFromUrlParams()
})

// ---- Enum Options ----
const roles = [
  { value: 'CLIENT', label: 'Client - Standard messaging device' },
  { value: 'CLIENT_MUTE', label: 'Client Mute - Does not forward packets' },
  { value: 'CLIENT_HIDDEN', label: 'Client Hidden - Hidden from node list' },
  { value: 'ROUTER', label: 'Router - Infrastructure relay node' },
  { value: 'REPEATER', label: 'Repeater - Minimal relay, no display' },
  { value: 'TRACKER', label: 'Tracker - Position tracking device' },
  { value: 'SENSOR', label: 'Sensor - Telemetry/environment sensor' },
  { value: 'TAK', label: 'TAK - Team Awareness Kit device' },
  { value: 'TAK_TRACKER', label: 'TAK Tracker - TAK + position tracking' },
  { value: 'LOST_AND_FOUND', label: 'Lost and Found - Asset tracking' },
]

const regions = [
  { value: 'UNSET', label: 'Unset' },
  { value: 'US', label: 'US - United States (915 MHz)' },
  { value: 'EU_868', label: 'EU 868 - Europe (868 MHz)' },
  { value: 'EU_433', label: 'EU 433 - Europe (433 MHz)' },
  { value: 'CN', label: 'CN - China' },
  { value: 'JP', label: 'JP - Japan' },
  { value: 'ANZ', label: 'ANZ - Australia/New Zealand (915 MHz)' },
  { value: 'ANZ_433', label: 'ANZ 433 - Australia/New Zealand (433 MHz)' },
  { value: 'KR', label: 'KR - South Korea' },
  { value: 'TW', label: 'TW - Taiwan' },
  { value: 'RU', label: 'RU - Russia' },
  { value: 'IN', label: 'IN - India' },
  { value: 'NZ_865', label: 'NZ 865 - New Zealand (865 MHz)' },
  { value: 'TH', label: 'TH - Thailand' },
  { value: 'UA_433', label: 'UA 433 - Ukraine (433 MHz)' },
  { value: 'UA_868', label: 'UA 868 - Ukraine (868 MHz)' },
  { value: 'MY_433', label: 'MY 433 - Malaysia (433 MHz)' },
  { value: 'MY_919', label: 'MY 919 - Malaysia (919 MHz)' },
  { value: 'SG_923', label: 'SG 923 - Singapore (923 MHz)' },
  { value: 'PH_433', label: 'PH 433 - Philippines (433 MHz)' },
  { value: 'PH_868', label: 'PH 868 - Philippines (868 MHz)' },
  { value: 'PH_915', label: 'PH 915 - Philippines (915 MHz)' },
  { value: 'LORA_24', label: 'LoRa 2.4 GHz' },
  { value: 'KZ_433', label: 'KZ 433 - Kazakhstan (433 MHz)' },
  { value: 'KZ_863', label: 'KZ 863 - Kazakhstan (863 MHz)' },
  { value: 'NP_865', label: 'NP 865 - Nepal (865 MHz)' },
  { value: 'BR_902', label: 'BR 902 - Brazil (902 MHz)' },
]

const presets = [
  { value: 'LONG_FAST', label: 'Long Fast (default)' },
  { value: 'LONG_MODERATE', label: 'Long Moderate' },
  { value: 'LONG_SLOW', label: 'Long Slow' },
  { value: 'VERY_LONG_SLOW', label: 'Very Long Slow' },
  { value: 'MEDIUM_FAST', label: 'Medium Fast' },
  { value: 'MEDIUM_SLOW', label: 'Medium Slow' },
  { value: 'SHORT_FAST', label: 'Short Fast' },
  { value: 'SHORT_SLOW', label: 'Short Slow' },
  { value: 'SHORT_TURBO', label: 'Short Turbo' },
]

// ---- Validation ----
const isFormValid = computed(() => {
  return config.value.region !== 'UNSET'
})

// ---- URL Parameter Loading ----
function loadFromUrlParams() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)

  if (params.has('longName')) config.value.longName = params.get('longName')
  if (params.has('shortName')) config.value.shortName = params.get('shortName')
  if (params.has('key')) config.value.privateKey = params.get('key')
  if (params.has('role')) config.value.role = params.get('role')
  if (params.has('region')) config.value.region = params.get('region')
  if (params.has('preset')) config.value.preset = params.get('preset')
  if (params.has('channel')) config.value.channelName = params.get('channel')
  if (params.has('psk')) config.value.channelPsk = params.get('psk')
}

// ---- Key Generation ----
function generatePrivateKey() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  config.value.privateKey = uint8ArrayToBase64(bytes)
}

function generateChannelPsk() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  config.value.channelPsk = uint8ArrayToBase64(bytes)
}

function uint8ArrayToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---- Share Link ----
function generateShareLink() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams()

  // Always include these
  params.set('region', config.value.region)
  params.set('role', config.value.role)
  params.set('preset', config.value.preset)
  if (config.value.channelName) params.set('channel', config.value.channelName)

  // Optionally include sensitive fields
  if (shareOptions.value.longName && config.value.longName) {
    params.set('longName', config.value.longName)
  }
  if (shareOptions.value.shortName && config.value.shortName) {
    params.set('shortName', config.value.shortName)
  }
  if (shareOptions.value.privateKey && config.value.privateKey) {
    params.set('key', config.value.privateKey)
  }
  if (shareOptions.value.channelPsk && config.value.channelPsk) {
    params.set('psk', config.value.channelPsk)
  }

  const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`
  navigator.clipboard.writeText(url).then(() => {
    copiedLink.value = true
    setTimeout(() => { copiedLink.value = false }, 3000)
  })
}

// ---- Device Connection ----
// These will be implemented in Task 3
async function connectSerial() {
  // Placeholder - implemented in Task 3
}

async function connectBle() {
  // Placeholder - implemented in Task 3
}

function writeToDevice() {
  showConfirmDialog.value = true
}

async function confirmWrite() {
  showConfirmDialog.value = false
  // Placeholder - implemented in Task 3
}
</script>

<style scoped>
/* Reuse styles from DockerComposeConfigurator - see Task 4 for full styles */
.configurator {
  max-width: 800px;
  margin: 0 auto;
}

.config-section {
  margin: 2rem 0;
  padding: 1.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}

.config-section h3 {
  margin-top: 0;
  color: var(--vp-c-brand-1);
}

.description {
  color: var(--vp-c-text-2);
  margin-bottom: 2rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.text-input, .select-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  font-size: 0.95rem;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

.text-input:focus, .select-input:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
}

.field-help {
  font-size: 0.85rem;
  color: var(--vp-c-text-3);
  margin-top: 0.25rem;
}

.input-with-button {
  display: flex;
  gap: 0.5rem;
}

.input-with-button .text-input {
  flex: 1;
}

.action-btn {
  padding: 0.5rem 1rem;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-brand-1);
  cursor: pointer;
  font-size: 0.95rem;
  white-space: nowrap;
}

.action-btn:hover:not(:disabled) {
  background: var(--vp-c-brand-1);
  color: var(--vp-c-bg);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.primary {
  background: var(--vp-c-brand-1);
  color: white;
}

.action-btn.primary:hover:not(:disabled) {
  background: var(--vp-c-brand-2);
}

.action-btn.small {
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.checkbox-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.connection-buttons {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.status-text {
  font-size: 0.9rem;
  margin-top: 0.5rem;
}

.status-text.connecting { color: var(--vp-c-brand-1); }
.status-text.connected { color: var(--vp-c-green-1, #10b981); }
.status-text.error { color: var(--vp-c-danger-1, #ef4444); }

.warning-box {
  padding: 1rem 1.5rem;
  background: var(--vp-c-danger-soft);
  border: 1px solid var(--vp-c-danger-1, #ef4444);
  border-radius: 8px;
  margin-bottom: 2rem;
}

.info-box {
  padding: 1rem 1.5rem;
  border-radius: 8px;
  margin-top: 1rem;
}

.info-box.success {
  background: var(--vp-c-green-soft, #d1fae5);
  border: 1px solid var(--vp-c-green-1, #10b981);
}

.info-box.error {
  background: var(--vp-c-danger-soft);
  border: 1px solid var(--vp-c-danger-1, #ef4444);
}

.help-text {
  color: var(--vp-c-text-2);
  margin-bottom: 1rem;
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-dialog {
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 2rem;
  max-width: 500px;
  width: 90%;
}

.modal-dialog h3 {
  margin-top: 0;
}

.modal-actions {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  margin-top: 1.5rem;
}
</style>
```

**Step 2: Verify the component has no syntax errors**

Run: `cd docs && npx vue-tsc --noEmit 2>&1 | head -20` (or just proceed to Task 3 which will test it in the browser)

**Step 3: Commit**

```bash
git add docs/.vitepress/theme/QuickNodeConfigurator.vue
git commit -m "feat: add Quick Node Configurator form component with URL params and share link"
```

---

## Task 3: Implement Device Connection and Write Logic

**Files:**
- Modify: `docs/.vitepress/theme/QuickNodeConfigurator.vue`

**Step 1: Add the meshtastic imports and enum mappings at the top of `<script setup>`**

Add these imports after the existing Vue import:

```javascript
// Dynamic imports to avoid SSR issues in VitePress
let MeshDevice, TransportWebSerial, TransportWebBluetooth, Protobuf, createProto

async function loadMeshtasticModules() {
  if (typeof window === 'undefined') return
  const core = await import('@meshtastic/core')
  MeshDevice = core.MeshDevice
  Protobuf = core.Protobuf
  const proto = await import('@bufbuild/protobuf')
  createProto = proto.create

  try {
    const serial = await import('@meshtastic/transport-web-serial')
    TransportWebSerial = serial.TransportWebSerial
  } catch (e) {
    console.warn('Web Serial transport not available')
  }
  try {
    const ble = await import('@meshtastic/transport-web-bluetooth')
    TransportWebBluetooth = ble.TransportWebBluetooth
  } catch (e) {
    console.warn('Web Bluetooth transport not available')
  }
}
```

Note: Dynamic imports are required because VitePress does SSR and Web Serial/Bluetooth APIs are browser-only.

**Step 2: Add role/region/preset enum mappings**

These map the string dropdown values to protobuf enum integers:

```javascript
const roleMap = {
  CLIENT: 0, CLIENT_MUTE: 1, ROUTER: 2, REPEATER: 4, TRACKER: 5,
  SENSOR: 6, TAK: 7, CLIENT_HIDDEN: 8, LOST_AND_FOUND: 9, TAK_TRACKER: 10,
}
const regionMap = {
  UNSET: 0, US: 1, EU_433: 2, EU_868: 3, CN: 4, JP: 5, ANZ: 6,
  KR: 7, TW: 8, RU: 9, IN: 10, NZ_865: 11, TH: 12, LORA_24: 13,
  UA_433: 14, UA_868: 15, MY_433: 16, MY_919: 17, SG_923: 18,
  PH_433: 19, PH_868: 20, PH_915: 21, ANZ_433: 22, KZ_433: 23,
  KZ_863: 24, NP_865: 25, BR_902: 26,
}
const presetMap = {
  LONG_FAST: 0, LONG_SLOW: 1, VERY_LONG_SLOW: 2, MEDIUM_SLOW: 3,
  MEDIUM_FAST: 4, SHORT_SLOW: 5, SHORT_FAST: 6, LONG_MODERATE: 7, SHORT_TURBO: 8,
}
```

**Step 3: Implement `connectSerial` function**

Replace the placeholder:

```javascript
async function connectSerial() {
  connectionStatus.value = 'connecting'
  connectionError.value = ''
  writeStatus.value = null
  try {
    await loadMeshtasticModules()
    const transport = await TransportWebSerial.create()
    const device = new MeshDevice(transport)

    // Wait for device to be configured (node DB received)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timed out')), 30000)
      device.events.onDeviceStatus.subscribe((status) => {
        if (status === 7) { // DeviceConfigured
          clearTimeout(timeout)
          resolve()
        }
      })
      device.configure()
    })

    meshDevice.value = device
    connectionType.value = 'serial'
    connectionStatus.value = 'connected'
  } catch (err) {
    connectionStatus.value = 'error'
    connectionError.value = err.message || 'Failed to connect via Serial'
    meshDevice.value = null
  }
}
```

**Step 4: Implement `connectBle` function**

Replace the placeholder:

```javascript
async function connectBle() {
  connectionStatus.value = 'connecting'
  connectionError.value = ''
  writeStatus.value = null
  try {
    await loadMeshtasticModules()
    if (!TransportWebBluetooth) {
      throw new Error('Web Bluetooth transport not available')
    }
    const transport = await TransportWebBluetooth.create()
    const device = new MeshDevice(transport)

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timed out')), 30000)
      device.events.onDeviceStatus.subscribe((status) => {
        if (status === 7) { // DeviceConfigured
          clearTimeout(timeout)
          resolve()
        }
      })
      device.configure()
    })

    meshDevice.value = device
    connectionType.value = 'ble'
    connectionStatus.value = 'connected'
  } catch (err) {
    connectionStatus.value = 'error'
    connectionError.value = err.message || 'Failed to connect via Bluetooth'
    meshDevice.value = null
  }
}
```

**Step 5: Implement `confirmWrite` function**

Replace the placeholder:

```javascript
async function confirmWrite() {
  showConfirmDialog.value = false
  isWriting.value = true
  writeStatus.value = null
  writeError.value = ''

  try {
    const device = meshDevice.value
    if (!device) throw new Error('No device connected')

    // 1. Set owner (User)
    const user = createProto(Protobuf.Mesh.UserSchema, {
      longName: config.value.longName,
      shortName: config.value.shortName,
      role: roleMap[config.value.role] ?? 0,
    })
    if (config.value.privateKey) {
      user.publicKey = base64ToUint8Array(config.value.privateKey)
    }
    await device.setOwner(user)

    // 2. Set LoRa config (region + modem preset)
    const loraConfig = createProto(Protobuf.Config.Config_LoRaConfigSchema, {
      region: regionMap[config.value.region] ?? 0,
      modemPreset: presetMap[config.value.preset] ?? 0,
    })
    const loraConfigWrapper = createProto(Protobuf.Config.ConfigSchema, {
      payloadVariant: { case: 'lora', value: loraConfig },
    })
    await device.setConfig(loraConfigWrapper)

    // 3. Set device config (role)
    const deviceConfig = createProto(Protobuf.Config.Config_DeviceConfigSchema, {
      role: roleMap[config.value.role] ?? 0,
    })
    const deviceConfigWrapper = createProto(Protobuf.Config.ConfigSchema, {
      payloadVariant: { case: 'device', value: deviceConfig },
    })
    await device.setConfig(deviceConfigWrapper)

    // 4. Set primary channel
    const channelSettings = createProto(Protobuf.Channel.ChannelSettingsSchema, {
      name: config.value.channelName,
      psk: config.value.channelPsk ? base64ToUint8Array(config.value.channelPsk) : new Uint8Array([1]),
    })
    const channel = createProto(Protobuf.Channel.ChannelSchema, {
      index: 0,
      settings: channelSettings,
      role: 1, // PRIMARY
    })
    await device.setChannel(channel)

    writeStatus.value = 'success'
  } catch (err) {
    writeStatus.value = 'error'
    writeError.value = err.message || 'Failed to write configuration'
  } finally {
    isWriting.value = false
  }
}
```

**Step 6: Call `loadMeshtasticModules()` in `onMounted`**

Update the existing onMounted to also load modules:

```javascript
onMounted(() => {
  isSerialSupported.value = 'serial' in navigator
  isBleSupported.value = 'bluetooth' in navigator
  loadFromUrlParams()
  loadMeshtasticModules() // preload (don't await, not critical)
})
```

**Step 7: Commit**

```bash
git add docs/.vitepress/theme/QuickNodeConfigurator.vue
git commit -m "feat: implement Meshtastic device connection and config write via Web Serial/BLE"
```

---

## Task 4: Register Component and Create Page

**Files:**
- Modify: `docs/.vitepress/theme/index.ts`
- Create: `docs/quick-config.md`
- Modify: `docs/.vitepress/config.mts` (add to navigation)

**Step 1: Register the component in the theme**

Add to `docs/.vitepress/theme/index.ts`:

```typescript
import QuickNodeConfigurator from './QuickNodeConfigurator.vue'
```

And in `enhanceApp`:

```typescript
enhanceApp({ app }) {
  app.component('DockerComposeConfigurator', DockerComposeConfigurator)
  app.component('UserScriptsGallery', UserScriptsGallery)
  app.component('QuickNodeConfigurator', QuickNodeConfigurator)
}
```

**Step 2: Create the page**

Create `docs/quick-config.md`:

```markdown
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
```

**Step 3: Add to navigation**

In `docs/.vitepress/config.mts`, add to the `nav` array (alongside the Docker Compose Configurator):

```typescript
nav: [
  { text: 'Getting Started', link: '/getting-started' },
  { text: 'FAQ', link: '/faq' },
  { text: 'Site Gallery', link: '/site-gallery' },
  { text: 'User Scripts', link: '/user-scripts' },
  {
    text: 'Tools',
    items: [
      { text: 'Docker Compose Configurator', link: '/configurator' },
      { text: 'Quick Node Configurator', link: '/quick-config' },
    ]
  },
  {
    text: 'Docs',
    items: [
      { text: 'Features', link: '/features/settings' },
      { text: 'Configuration', link: '/configuration/' },
      { text: 'Add-ons', link: '/add-ons/' },
      { text: 'Development', link: '/development/' }
    ]
  },
  { text: 'Releases', link: 'https://github.com/yeraze/meshmonitor/releases' }
],
```

Also add to the Configuration sidebar:

```typescript
{ text: 'Quick Node Configurator', link: '/quick-config' },
```

Place it near the Docker Compose Configurator entry.

**Step 4: Commit**

```bash
git add docs/.vitepress/theme/index.ts docs/quick-config.md docs/.vitepress/config.mts
git commit -m "feat: add Quick Node Configurator page and navigation"
```

---

## Task 5: Test in VitePress Dev Server

**Step 1: Start the VitePress dev server**

```bash
cd docs && npx vitepress dev --port 5173
```

**Step 2: Manual testing checklist**

Open `http://localhost:5173/quick-config` in Chrome and verify:

- [ ] Page loads without console errors
- [ ] All form fields render correctly
- [ ] Dropdown options are populated (roles, regions, presets)
- [ ] "Generate" buttons create random base64 keys
- [ ] URL parameters auto-populate fields (test with `?region=EU_868&role=ROUTER&preset=LONG_SLOW`)
- [ ] "Generate & Copy Shareable Link" produces correct URL with selected optional fields
- [ ] Browser compatibility warning shows in Firefox/Safari (if testing there)
- [ ] Connect buttons appear for supported transports
- [ ] "Write Configuration" is disabled when no device connected
- [ ] Confirmation dialog appears when clicking Write
- [ ] Navigation links work from the nav bar and configuration sidebar

**Step 3: Fix any issues found during testing**

Address any rendering, styling, or functionality issues.

**Step 4: Test with a real Meshtastic device (if available)**

- Connect via USB Serial
- Verify connection succeeds and status shows "Connected"
- Write a test configuration
- Verify device restarts with new settings

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during Quick Node Configurator testing"
```

---

## Task 6: Build and Final Verification

**Step 1: Build the VitePress site**

```bash
cd docs && npx vitepress build
```

Expected: Build succeeds without errors. The `@meshtastic/*` packages should be properly bundled.

**Step 2: Preview the built site**

```bash
cd docs && npx vitepress preview --port 5173
```

Verify the Quick Node Configurator page works in the production build.

**Step 3: Fix any build issues**

Common issues:
- SSR errors from browser-only APIs → ensure all browser API access is behind `typeof window !== 'undefined'` checks or in `onMounted`
- Module resolution issues → check VitePress vite config for any needed `optimizeDeps` entries

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify Quick Node Configurator builds successfully"
```

---

## Important Notes for the Implementer

### SSR Safety
VitePress does server-side rendering. ALL browser-only APIs (`navigator.serial`, `navigator.bluetooth`, `window`, `crypto`) must be accessed only inside `onMounted()` or behind `typeof window !== 'undefined'` guards. The `@meshtastic/*` imports use dynamic `import()` for this reason.

### Protobuf API Pattern
The `@meshtastic/protobufs` package uses `@bufbuild/protobuf` v2. Create messages with:
```javascript
import { create } from '@bufbuild/protobuf'
import * as Protobuf from '@meshtastic/protobufs'
const user = create(Protobuf.Mesh.UserSchema, { longName: 'test' })
```

Note: `@meshtastic/core` re-exports `Protobuf` from `@meshtastic/protobufs`, so you can use `Protobuf` from core directly.

### MeshDevice Lifecycle
1. Create transport: `TransportWebSerial.create()` → triggers browser device picker
2. Create device: `new MeshDevice(transport)`
3. Configure: `device.configure()` → device sends its node DB
4. Wait for `DeviceConfigured` status (enum value 7)
5. Then call `setOwner()`, `setConfig()`, `setChannel()`

### Config Wrapper Pattern
`setConfig()` expects a `Config` message with a `payloadVariant` oneof:
```javascript
{ payloadVariant: { case: 'device', value: deviceConfig } }
{ payloadVariant: { case: 'lora', value: loraConfig } }
```

### The `@meshtastic/js` Package is Deprecated
Do NOT use `@meshtastic/js`. Use the new modular packages:
- `@meshtastic/core` - MeshDevice class, event system
- `@meshtastic/transport-web-serial` - Web Serial transport
- `@meshtastic/transport-web-bluetooth` - Web Bluetooth transport
- `@meshtastic/protobufs` - Protobuf schemas and enums
