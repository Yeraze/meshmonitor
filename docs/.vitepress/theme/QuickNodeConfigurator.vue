<template>
  <div class="configurator">
    <h2>Quick Node Configurator</h2>
    <p class="description">
      Configure your Meshtastic node directly from the browser using Web Serial or Web Bluetooth.
      Fill in the settings below, connect to your device, and write the configuration.
    </p>

    <!-- Browser Compatibility Warning -->
    <div v-if="!isSecureContext" class="warning-box">
      <strong>Secure Context Required</strong>
      <p>
        Device connection requires HTTPS or localhost access. You are currently using an
        insecure connection. The form and shareable link features still work, but to connect
        and write to a device, access this page via <strong>https://</strong> or
        <strong>localhost</strong>.
      </p>
    </div>
    <div v-else-if="!browserSupport.serial && !browserSupport.bluetooth" class="warning-box">
      <strong>Browser Not Supported</strong>
      <p>
        Your browser does not support Web Serial or Web Bluetooth. Please use a
        Chromium-based browser (Chrome, Edge, Brave, Opera) on desktop to connect to a device.
        The form and shareable link features still work in any browser.
      </p>
    </div>

    <!-- Section 1: Node Identity -->
    <section class="config-section">
      <h3>1. Node Identity</h3>
      <p class="help-text">Set a name and optional encryption key for your node.</p>

      <div class="form-group">
        <label for="longName">Long Name</label>
        <input
          id="longName"
          v-model="config.longName"
          type="text"
          placeholder="My Meshtastic Node"
          class="text-input"
          maxlength="39"
        />
        <p class="field-help">Friendly name shown on the mesh (max 39 characters)</p>
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
        <p class="field-help">Short identifier, 1-4 characters</p>
      </div>

      <div class="form-group">
        <label for="privateKey">Private Key (PKI)</label>
        <div class="input-with-button">
          <input
            id="privateKey"
            v-model="config.privateKey"
            type="text"
            placeholder="Base64-encoded 32-byte key (optional)"
            class="text-input"
          />
          <button @click="generatePrivateKey" class="action-btn small">Generate</button>
        </div>
        <p class="field-help">Optional Ed25519 private key for PKI encryption. Leave blank to skip.</p>
      </div>
    </section>

    <!-- Section 2: Radio Settings -->
    <section class="config-section">
      <h3>2. Radio Settings</h3>
      <p class="help-text">Configure the device role, frequency region, and modem preset.</p>

      <div class="form-group">
        <label for="role">Device Role</label>
        <select id="role" v-model="config.role" class="select-input">
          <option v-for="r in roles" :key="r" :value="r">{{ r }}</option>
        </select>
        <p class="field-help">Determines how the node behaves on the mesh network.</p>
      </div>

      <div class="form-group">
        <label for="region">Region</label>
        <select id="region" v-model="config.region" class="select-input">
          <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
        </select>
        <p class="field-help">Must match your country/region's frequency regulations.</p>
      </div>

      <div class="form-group">
        <label for="preset">Modem Preset</label>
        <select id="preset" v-model="config.preset" class="select-input">
          <option v-for="p in presets" :key="p" :value="p">{{ p }}</option>
        </select>
        <p class="field-help">Determines range vs. data rate tradeoff. All nodes on a channel must use the same preset.</p>
      </div>
    </section>

    <!-- Section 3: Primary Channel -->
    <section class="config-section">
      <h3>3. Primary Channel</h3>
      <p class="help-text">Configure the primary channel name and encryption key.</p>

      <div class="form-group">
        <label for="channelName">Channel Name</label>
        <input
          id="channelName"
          v-model="config.channelName"
          type="text"
          placeholder="LongFast"
          class="text-input"
          maxlength="11"
        />
        <p class="field-help">Name of the primary channel (max 11 characters). Leave empty for default.</p>
      </div>

      <div class="form-group">
        <label for="channelPsk">Channel PSK</label>
        <div class="input-with-button">
          <input
            id="channelPsk"
            v-model="config.channelPsk"
            type="text"
            placeholder="Base64-encoded pre-shared key (optional)"
            class="text-input"
          />
          <button @click="generateChannelPsk" class="action-btn small">Generate</button>
        </div>
        <p class="field-help">Optional pre-shared key for channel encryption. Leave blank for default key.</p>
      </div>
    </section>

    <!-- Section 4: Shareable Link -->
    <section class="config-section">
      <h3>4. Shareable Link</h3>
      <p class="help-text">Generate a URL that pre-fills this configurator for other users.</p>

      <div class="checkbox-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="shareOptions.longName" />
          Include Long Name
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="shareOptions.shortName" />
          Include Short Name
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="shareOptions.privateKey" />
          Include Private Key
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="shareOptions.channelPsk" />
          Include Channel PSK
        </label>
      </div>

      <div class="form-group" style="margin-top: 1rem;">
        <button @click="generateShareLink" class="action-btn">Generate Share Link</button>
        <div v-if="shareLink" class="share-link-box">
          <input :value="shareLink" class="text-input" readonly @click="$event.target.select()" />
          <button @click="copyShareLink" class="action-btn small">
            {{ copiedShareLink ? 'Copied!' : 'Copy' }}
          </button>
        </div>
      </div>
    </section>

    <!-- Section 5: Connect & Write -->
    <section class="config-section">
      <h3>5. Connect &amp; Write</h3>
      <p class="help-text">Connect to your Meshtastic device and write the configuration.</p>

      <div class="connect-buttons">
        <button
          v-if="browserSupport.serial"
          @click="connectSerial"
          :disabled="connectionState.connecting || connectionState.connected"
          class="action-btn"
        >
          {{ connectionState.connecting && connectionState.transport === 'serial' ? 'Connecting...' : 'Connect via Serial' }}
        </button>
        <button
          v-if="browserSupport.bluetooth"
          @click="connectBle"
          :disabled="connectionState.connecting || connectionState.connected"
          class="action-btn"
        >
          {{ connectionState.connecting && connectionState.transport === 'ble' ? 'Connecting...' : 'Connect via Bluetooth' }}
        </button>
      </div>

      <div v-if="connectionState.connected" class="status-box success">
        Connected via {{ connectionState.transport === 'serial' ? 'Web Serial' : 'Web Bluetooth' }}
      </div>
      <div v-if="connectionState.error" class="status-box error">
        {{ connectionState.error }}
      </div>

      <div v-if="connectionState.connected" class="form-group" style="margin-top: 1rem;">
        <button @click="showWriteConfirm = true" :disabled="writeState.writing" class="action-btn primary">
          {{ writeState.writing ? 'Writing...' : 'Write Configuration to Device' }}
        </button>
      </div>

      <div v-if="writeState.status" class="status-box" :class="writeState.success ? 'success' : 'error'">
        {{ writeState.status }}
      </div>
    </section>

    <!-- Write Confirmation Modal -->
    <div v-if="showWriteConfirm" class="modal-overlay" @click.self="showWriteConfirm = false">
      <div class="modal-dialog">
        <h3>Confirm Write Configuration</h3>
        <p>This will overwrite the following settings on your connected device:</p>
        <ul>
          <li v-if="config.longName"><strong>Long Name:</strong> {{ config.longName }}</li>
          <li v-if="config.shortName"><strong>Short Name:</strong> {{ config.shortName }}</li>
          <li v-if="config.privateKey"><strong>Private Key:</strong> (set)</li>
          <li><strong>Role:</strong> {{ config.role }}</li>
          <li><strong>Region:</strong> {{ config.region }}</li>
          <li><strong>Preset:</strong> {{ config.preset }}</li>
          <li v-if="config.channelName"><strong>Channel:</strong> {{ config.channelName }}</li>
          <li v-if="config.channelPsk"><strong>Channel PSK:</strong> (set)</li>
        </ul>
        <p class="warning-text">The device will reboot after writing. Are you sure?</p>
        <div class="modal-actions">
          <button @click="showWriteConfirm = false" class="action-btn">Cancel</button>
          <button @click="confirmWrite" class="action-btn primary">Write to Device</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'

// --- Enum options ---
const roles = [
  'CLIENT', 'CLIENT_MUTE', 'CLIENT_HIDDEN', 'ROUTER', 'REPEATER',
  'TRACKER', 'SENSOR', 'TAK', 'TAK_TRACKER', 'LOST_AND_FOUND'
]

const regions = [
  'UNSET', 'US', 'EU_868', 'EU_433', 'CN', 'JP', 'ANZ', 'ANZ_433',
  'KR', 'TW', 'RU', 'IN', 'NZ_865', 'TH', 'UA_433', 'UA_868',
  'MY_433', 'MY_919', 'SG_923', 'PH_433', 'PH_868', 'PH_915',
  'LORA_24', 'KZ_433', 'KZ_863', 'NP_865', 'BR_902'
]

const presets = [
  'LONG_FAST', 'LONG_MODERATE', 'LONG_SLOW', 'VERY_LONG_SLOW',
  'MEDIUM_FAST', 'MEDIUM_SLOW', 'SHORT_FAST', 'SHORT_SLOW', 'SHORT_TURBO'
]

// --- Protobuf enum integer mappings ---
const roleMap = {
  CLIENT: 0, CLIENT_MUTE: 1, ROUTER: 2, REPEATER: 4, TRACKER: 5,
  SENSOR: 6, TAK: 7, CLIENT_HIDDEN: 8, LOST_AND_FOUND: 9, TAK_TRACKER: 10
}

const regionMap = {
  UNSET: 0, US: 1, EU_433: 2, EU_868: 3, CN: 4, JP: 5, ANZ: 6, KR: 7,
  TW: 8, RU: 9, IN: 10, NZ_865: 11, TH: 12, LORA_24: 13, UA_433: 14,
  UA_868: 15, MY_433: 16, MY_919: 17, SG_923: 18, PH_433: 19, PH_868: 20,
  PH_915: 21, ANZ_433: 22, KZ_433: 23, KZ_863: 24, NP_865: 25, BR_902: 26
}

const presetMap = {
  LONG_FAST: 0, LONG_SLOW: 1, VERY_LONG_SLOW: 2, MEDIUM_SLOW: 3,
  MEDIUM_FAST: 4, SHORT_SLOW: 5, SHORT_FAST: 6, LONG_MODERATE: 7, SHORT_TURBO: 8
}

// --- State ---
const config = reactive({
  longName: '',
  shortName: '',
  privateKey: '',
  role: 'CLIENT',
  region: 'US',
  preset: 'LONG_FAST',
  channelName: '',
  channelPsk: ''
})

const shareOptions = reactive({
  longName: true,
  shortName: true,
  privateKey: false,
  channelPsk: false
})

const connectionState = reactive({
  connected: false,
  connecting: false,
  transport: '',
  error: ''
})

const writeState = reactive({
  writing: false,
  status: '',
  success: false
})

const isSecureContext = ref(false)
const browserSupport = reactive({
  serial: false,
  bluetooth: false
})

const showWriteConfirm = ref(false)
const shareLink = ref('')
const copiedShareLink = ref(false)

// --- Dynamic meshtastic imports (SSR-safe) ---
let MeshDevice = null
let TransportWebSerial = null
let TransportWebBluetooth = null
let Protobuf = null
let createProto = null
let device = null

async function loadMeshtasticModules() {
  if (typeof window === 'undefined') return

  try {
    const core = await import('@meshtastic/core')
    MeshDevice = core.MeshDevice
    Protobuf = core.Protobuf
  } catch (e) {
    console.warn('Failed to load @meshtastic/core:', e)
  }

  try {
    const proto = await import('@bufbuild/protobuf')
    createProto = proto.create
  } catch (e) {
    console.warn('Failed to load @bufbuild/protobuf:', e)
  }

  try {
    const serial = await import('@meshtastic/transport-web-serial')
    TransportWebSerial = serial.TransportWebSerial
  } catch (e) {
    console.warn('Web Serial transport not available:', e)
  }

  try {
    const ble = await import('@meshtastic/transport-web-bluetooth')
    TransportWebBluetooth = ble.TransportWebBluetooth
  } catch (e) {
    console.warn('Web Bluetooth transport not available:', e)
  }
}

// --- Lifecycle ---
onMounted(async () => {
  // Detect secure context and browser support
  isSecureContext.value = typeof window !== 'undefined' && window.isSecureContext
  browserSupport.serial = typeof navigator !== 'undefined' && 'serial' in navigator
  browserSupport.bluetooth = typeof navigator !== 'undefined' && 'bluetooth' in navigator

  // Load URL params
  loadUrlParams()

  // Preload meshtastic modules
  await loadMeshtasticModules()
})

// --- URL param loading ---
function loadUrlParams() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)

  if (params.has('longName')) config.longName = params.get('longName')
  if (params.has('shortName')) config.shortName = params.get('shortName')
  if (params.has('key')) config.privateKey = params.get('key')
  if (params.has('role') && roles.includes(params.get('role'))) config.role = params.get('role')
  if (params.has('region') && regions.includes(params.get('region'))) config.region = params.get('region')
  if (params.has('preset') && presets.includes(params.get('preset'))) config.preset = params.get('preset')
  if (params.has('channel')) config.channelName = params.get('channel')
  if (params.has('psk')) config.channelPsk = params.get('psk')
}

// --- Key generation ---
function generatePrivateKey() {
  if (typeof window === 'undefined') return
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  config.privateKey = btoa(String.fromCharCode(...bytes))
}

function generateChannelPsk() {
  if (typeof window === 'undefined') return
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  config.channelPsk = btoa(String.fromCharCode(...bytes))
}

// --- Share link generation ---
function generateShareLink() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams()

  // Always include radio settings and channel name
  params.set('role', config.role)
  params.set('region', config.region)
  params.set('preset', config.preset)
  if (config.channelName) params.set('channel', config.channelName)

  // Optionally include identity and keys
  if (shareOptions.longName && config.longName) params.set('longName', config.longName)
  if (shareOptions.shortName && config.shortName) params.set('shortName', config.shortName)
  if (shareOptions.privateKey && config.privateKey) params.set('key', config.privateKey)
  if (shareOptions.channelPsk && config.channelPsk) params.set('psk', config.channelPsk)

  const base = window.location.origin + window.location.pathname
  shareLink.value = `${base}?${params.toString()}`
}

async function copyShareLink() {
  if (!shareLink.value) return
  try {
    await navigator.clipboard.writeText(shareLink.value)
    copiedShareLink.value = true
    setTimeout(() => { copiedShareLink.value = false }, 2000)
  } catch (err) {
    console.error('Failed to copy share link:', err)
  }
}

// --- Device connection ---
async function connectSerial() {
  if (!TransportWebSerial || !MeshDevice) {
    await loadMeshtasticModules()
  }
  if (!TransportWebSerial || !MeshDevice) {
    connectionState.error = 'Failed to load Meshtastic libraries. Check browser console for details.'
    return
  }

  connectionState.connecting = true
  connectionState.transport = 'serial'
  connectionState.error = ''

  let transport = null
  try {
    transport = await TransportWebSerial.create()
    device = new MeshDevice(transport)

    // Match the official Meshtastic web client pattern:
    // configure() immediately, then start heartbeats during configuration
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timed out after 60 seconds. Check that the device is powered on and not in use by another application.'))
      }, 60000)

      device.events.onDeviceStatus.subscribe((status) => {
        console.log('[QuickConfig] Device status:', status)
        if (status === 7) {
          clearTimeout(timeout)
          clearInterval(heartbeatInterval)
          resolve()
        }
      })

      // Start configuration immediately (official client does the same)
      device.configure().then(() => {
        console.log('[QuickConfig] configure() resolved, sending initial heartbeat')
        device.heartbeat().catch(err => console.warn('[QuickConfig] heartbeat failed:', err))
      }).catch((err) => {
        clearTimeout(timeout)
        reject(err)
      })

      // Send heartbeats every 5s during configuration (keeps serial connection alive)
      const heartbeatInterval = setInterval(() => {
        if (device) {
          device.heartbeat().catch(err => console.warn('[QuickConfig] heartbeat failed:', err))
        }
      }, 5000)
    })

    connectionState.connected = true
    connectionState.connecting = false
  } catch (err) {
    connectionState.connecting = false
    connectionState.error = `Serial connection failed: ${err.message || err}`
    // Clean up transport to release the serial port
    if (transport) {
      try { await transport.disconnect() } catch (e) { console.warn('[QuickConfig] cleanup error:', e) }
    }
    device = null
  }
}

async function connectBle() {
  if (!TransportWebBluetooth || !MeshDevice) {
    await loadMeshtasticModules()
  }
  if (!TransportWebBluetooth || !MeshDevice) {
    connectionState.error = 'Failed to load Meshtastic libraries. Check browser console for details.'
    return
  }

  connectionState.connecting = true
  connectionState.transport = 'ble'
  connectionState.error = ''

  let transport = null
  try {
    transport = await TransportWebBluetooth.create()
    device = new MeshDevice(transport)

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timed out after 60 seconds. Check that the device is powered on and not in use by another application.'))
      }, 60000)

      device.events.onDeviceStatus.subscribe((status) => {
        console.log('[QuickConfig] Device status:', status)
        if (status === 7) {
          clearTimeout(timeout)
          clearInterval(heartbeatInterval)
          resolve()
        }
      })

      device.configure().then(() => {
        console.log('[QuickConfig] configure() resolved, sending initial heartbeat')
        device.heartbeat().catch(err => console.warn('[QuickConfig] heartbeat failed:', err))
      }).catch((err) => {
        clearTimeout(timeout)
        reject(err)
      })

      const heartbeatInterval = setInterval(() => {
        if (device) {
          device.heartbeat().catch(err => console.warn('[QuickConfig] heartbeat failed:', err))
        }
      }, 5000)
    })

    connectionState.connected = true
    connectionState.connecting = false
  } catch (err) {
    connectionState.connecting = false
    connectionState.error = `Bluetooth connection failed: ${err.message || err}`
    if (transport) {
      try { await transport.disconnect() } catch (e) { console.warn('[QuickConfig] cleanup error:', e) }
    }
    device = null
  }
}

// --- Write configuration ---
async function confirmWrite() {
  showWriteConfirm.value = false

  if (!device || !Protobuf || !createProto) {
    writeState.status = 'Device not connected or meshtastic modules not loaded.'
    writeState.success = false
    return
  }

  writeState.writing = true
  writeState.status = ''
  writeState.success = false

  try {
    // Begin edit transaction — batches all config changes so the device
    // only reboots once after commitEditSettings(), not after each call.
    await device.beginEditSettings()

    // Set owner (user info)
    const userPayload = {
      longName: config.longName || undefined,
      shortName: config.shortName || undefined,
      role: roleMap[config.role] ?? 0
    }

    // If private key is set, derive public key placeholder (device handles it)
    if (config.privateKey) {
      try {
        const keyBytes = Uint8Array.from(atob(config.privateKey), c => c.charCodeAt(0))
        userPayload.publicKey = keyBytes
      } catch (e) {
        console.warn('Invalid private key format:', e)
      }
    }

    const user = createProto(Protobuf.Mesh.UserSchema, userPayload)
    await device.setOwner(user)

    // Set LoRa config
    const loraConfig = createProto(Protobuf.Config.Config_LoRaConfigSchema, {
      region: regionMap[config.region] ?? 0,
      modemPreset: presetMap[config.preset] ?? 0
    })
    const loraConfigWrapper = createProto(Protobuf.Config.ConfigSchema, {
      payloadVariant: { case: 'lora', value: loraConfig }
    })
    await device.setConfig(loraConfigWrapper)

    // Set device config (role)
    const deviceConfig = createProto(Protobuf.Config.Config_DeviceConfigSchema, {
      role: roleMap[config.role] ?? 0
    })
    const deviceConfigWrapper = createProto(Protobuf.Config.ConfigSchema, {
      payloadVariant: { case: 'device', value: deviceConfig }
    })
    await device.setConfig(deviceConfigWrapper)

    // Set primary channel
    if (config.channelName || config.channelPsk) {
      const channelSettings = {}
      if (config.channelName) channelSettings.name = config.channelName
      if (config.channelPsk) {
        try {
          channelSettings.psk = Uint8Array.from(atob(config.channelPsk), c => c.charCodeAt(0))
        } catch (e) {
          console.warn('Invalid channel PSK format:', e)
        }
      }

      const channel = createProto(Protobuf.Channel.ChannelSchema, {
        index: 0,
        settings: channelSettings,
        role: 1 // PRIMARY
      })
      await device.setChannel(channel)
    }

    // Commit all changes — device reboots once with all settings applied
    await device.commitEditSettings()

    writeState.status = 'Configuration written successfully. The device will reboot.'
    writeState.success = true
  } catch (err) {
    writeState.status = `Write failed: ${err.message || err}`
    writeState.success = false
  } finally {
    writeState.writing = false
  }
}
</script>

<style scoped>
.configurator {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 0;
}

.description {
  color: var(--vp-c-text-2);
  margin-bottom: 2rem;
}

.config-section {
  margin-bottom: 3rem;
  padding: 1.5rem;
  background-color: var(--vp-c-bg-soft);
  border-radius: 8px;
}

.config-section h3 {
  margin-top: 0;
  margin-bottom: 0.5rem;
  border-bottom: 2px solid var(--vp-c-brand-1);
  padding-bottom: 0.5rem;
}

.help-text {
  color: var(--vp-c-text-2);
  margin-bottom: 1rem;
  font-size: 0.95rem;
}

.form-group {
  margin-top: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
}

.text-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  font-size: 1rem;
  font-family: var(--vp-font-family-mono);
  background-color: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  box-sizing: border-box;
}

.text-input:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
}

.select-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  font-size: 1rem;
  background-color: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
}

.select-input:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
}

.field-help {
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
  margin-top: 0.25rem;
  margin-bottom: 1rem;
}

.input-with-button {
  display: flex;
  gap: 0.5rem;
  align-items: stretch;
}

.input-with-button .text-input {
  flex: 1;
}

.action-btn {
  padding: 0.5rem 1.25rem;
  background-color: var(--vp-c-brand-1);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.95rem;
  transition: background-color 0.2s;
  white-space: nowrap;
}

.action-btn:hover:not(:disabled) {
  background-color: var(--vp-c-brand-2);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.small {
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
}

.action-btn.primary {
  background-color: var(--vp-c-brand-1);
  font-weight: 600;
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.95rem;
}

.checkbox-label input[type="checkbox"] {
  cursor: pointer;
}

.share-link-box {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  align-items: stretch;
}

.share-link-box .text-input {
  flex: 1;
  font-size: 0.85rem;
  cursor: pointer;
}

.connect-buttons {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.status-box {
  margin-top: 0.75rem;
  padding: 0.75rem 1rem;
  border-radius: 6px;
  font-size: 0.95rem;
}

.status-box.success {
  background-color: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #10b981;
}

.status-box.error {
  background-color: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.warning-box {
  margin-bottom: 2rem;
  padding: 1rem 1.25rem;
  background-color: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  color: var(--vp-c-text-1);
}

.warning-box strong {
  display: block;
  margin-bottom: 0.5rem;
  color: #f59e0b;
}

.warning-box p {
  margin: 0;
  font-size: 0.95rem;
}

.warning-text {
  color: #f59e0b;
  font-weight: 500;
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-dialog {
  background-color: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 1.5rem 2rem;
  max-width: 500px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
}

.modal-dialog h3 {
  margin-top: 0;
  margin-bottom: 1rem;
}

.modal-dialog ul {
  margin: 0.75rem 0;
  padding-left: 1.5rem;
}

.modal-dialog li {
  margin-bottom: 0.4rem;
  font-size: 0.95rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
}
</style>
