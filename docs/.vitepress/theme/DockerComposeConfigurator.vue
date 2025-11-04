<template>
  <div class="configurator">
    <h2>MeshMonitor Docker Compose Configurator</h2>
    <p class="description">
      Configure your MeshMonitor deployment by selecting your options below. This tool will generate
      a ready-to-use <code>docker-compose.yml</code> and <code>.env</code> file for your setup.
    </p>

    <!-- Connection Type -->
    <section class="config-section">
      <h3>1. Connection Type</h3>
      <p class="help-text">How is your Meshtastic node connected?</p>

      <div class="radio-group">
        <label class="radio-option" :class="{ selected: config.connectionType === 'tcp' }">
          <input type="radio" v-model="config.connectionType" value="tcp" />
          <div class="option-content">
            <strong>TCP/Network</strong>
            <span class="option-desc">Direct network connection (WiFi/Ethernet)</span>
          </div>
        </label>

        <label class="radio-option" :class="{ selected: config.connectionType === 'ble' }">
          <input type="radio" v-model="config.connectionType" value="ble" />
          <div class="option-content">
            <strong>Bluetooth (BLE)</strong>
            <span class="option-desc">Bluetooth Low Energy connection via BLE Bridge</span>
          </div>
        </label>

        <label class="radio-option" :class="{ selected: config.connectionType === 'serial' }">
          <input type="radio" v-model="config.connectionType" value="serial" />
          <div class="option-content">
            <strong>USB/Serial</strong>
            <span class="option-desc">USB or serial connection via Serial Bridge</span>
          </div>
        </label>
      </div>
    </section>

    <!-- Connection Details -->
    <section class="config-section">
      <h3>2. Connection Details</h3>

      <div v-if="config.connectionType === 'tcp'" class="form-group">
        <label for="nodeIp">Node IP Address</label>
        <input
          id="nodeIp"
          v-model="config.nodeIp"
          type="text"
          placeholder="192.168.1.100"
          class="text-input"
        />
        <p class="field-help">The IP address of your Meshtastic node</p>

        <label for="nodePort">Node TCP Port</label>
        <input
          id="nodePort"
          v-model="config.nodePort"
          type="number"
          placeholder="4403"
          class="text-input"
        />
        <p class="field-help">Default is 4403</p>
      </div>

      <div v-if="config.connectionType === 'ble'" class="form-group">
        <label for="bleMac">BLE MAC Address</label>
        <input
          id="bleMac"
          v-model="config.bleMac"
          type="text"
          placeholder="AA:BB:CC:DD:EE:FF"
          class="text-input"
        />
        <p class="field-help">
          Find it by running: <code>docker run --rm --privileged -v /var/run/dbus:/var/run/dbus ghcr.io/yeraze/meshtastic-ble-bridge:latest --scan</code>
        </p>
      </div>

      <div v-if="config.connectionType === 'serial'" class="form-group">
        <label for="serialDevice">Serial Device Path</label>
        <input
          id="serialDevice"
          v-model="config.serialDevice"
          type="text"
          placeholder="/dev/ttyUSB0"
          class="text-input"
        />
        <p class="field-help">Common: /dev/ttyUSB0, /dev/ttyACM0 (Linux), /dev/cu.usbserial-* (macOS)</p>

        <label for="baudRate">Baud Rate</label>
        <input
          id="baudRate"
          v-model="config.baudRate"
          type="number"
          placeholder="115200"
          class="text-input"
        />
        <p class="field-help">Default is 115200</p>
      </div>
    </section>

    <!-- Deployment Mode -->
    <section class="config-section">
      <h3>3. Deployment Mode</h3>
      <p class="help-text">How will you access MeshMonitor?</p>

      <div class="radio-group">
        <label class="radio-option" :class="{ selected: config.deploymentMode === 'development' }">
          <input type="radio" v-model="config.deploymentMode" value="development" />
          <div class="option-content">
            <strong>Development (HTTP)</strong>
            <span class="option-desc">Simple HTTP access via localhost or local IP</span>
          </div>
        </label>

        <label class="radio-option" :class="{ selected: config.deploymentMode === 'production-proxy' }">
          <input type="radio" v-model="config.deploymentMode" value="production-proxy" />
          <div class="option-content">
            <strong>Production with Reverse Proxy</strong>
            <span class="option-desc">HTTPS via nginx, Caddy, or Traefik (recommended)</span>
          </div>
        </label>

        <label class="radio-option" :class="{ selected: config.deploymentMode === 'production-http' }">
          <input type="radio" v-model="config.deploymentMode" value="production-http" />
          <div class="option-content">
            <strong>Production without Reverse Proxy</strong>
            <span class="option-desc">Direct HTTP access (not recommended)</span>
          </div>
        </label>
      </div>
    </section>

    <!-- Reverse Proxy Settings -->
    <section v-if="config.deploymentMode === 'production-proxy'" class="config-section">
      <h3>4. Reverse Proxy Settings</h3>

      <div class="form-group">
        <label for="hostname">Hostname/Domain</label>
        <input
          id="hostname"
          v-model="config.hostname"
          type="text"
          placeholder="meshmonitor.example.com"
          class="text-input"
        />
        <p class="field-help">The domain name or hostname where MeshMonitor will be accessed</p>

        <div class="checkbox-group">
          <label class="checkbox-option">
            <input type="checkbox" v-model="config.useHttps" />
            <span>Using HTTPS (recommended)</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Port Configuration -->
    <section class="config-section">
      <h3>{{ config.deploymentMode === 'production-proxy' ? '5' : '4' }}. Port Configuration</h3>

      <div class="form-group">
        <label for="webPort">Web Interface Port</label>
        <input
          id="webPort"
          v-model="config.webPort"
          type="number"
          placeholder="8080"
          class="text-input"
        />
        <p class="field-help">
          {{ config.deploymentMode === 'production-proxy'
            ? 'Port for reverse proxy to connect to (not directly accessible)'
            : 'Port to access MeshMonitor web interface' }}
        </p>
      </div>
    </section>

    <!-- Security Settings -->
    <section class="config-section">
      <h3>{{ config.deploymentMode === 'production-proxy' ? '6' : '5' }}. Security Settings</h3>

      <div class="checkbox-group">
        <label class="checkbox-option">
          <input type="checkbox" v-model="config.enableVirtualNode" />
          <div class="option-content">
            <strong>Enable Virtual Node</strong>
            <span class="option-desc">Allows multiple Meshtastic mobile apps to connect simultaneously</span>
          </div>
        </label>

        <label class="checkbox-option">
          <input type="checkbox" v-model="config.disableAnonymous" />
          <div class="option-content">
            <strong>Disable Anonymous Access</strong>
            <span class="option-desc">Require authentication for all access</span>
          </div>
        </label>
      </div>

      <div v-if="config.enableVirtualNode" class="form-group">
        <label for="virtualNodePort">Virtual Node Port</label>
        <input
          id="virtualNodePort"
          v-model="config.virtualNodePort"
          type="number"
          placeholder="4404"
          class="text-input"
        />
        <p class="field-help">Port for Meshtastic mobile apps to connect (default: 4404)</p>
      </div>
    </section>

    <!-- Additional Settings -->
    <section class="config-section">
      <h3>{{ config.deploymentMode === 'production-proxy' ? '7' : '6' }}. Additional Settings</h3>

      <div class="form-group">
        <label for="timezone">Timezone</label>
        <input
          id="timezone"
          v-model="config.timezone"
          type="text"
          placeholder="America/New_York"
          class="text-input"
        />
        <p class="field-help">
          Your timezone (e.g., America/New_York, Europe/London, Asia/Tokyo)
          <a href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" target="_blank">See list</a>
        </p>
      </div>
    </section>

    <!-- Generated Files -->
    <section class="config-section results">
      <h3>{{ config.deploymentMode === 'production-proxy' ? '8' : '7' }}. Generated Configuration</h3>

      <div class="file-output">
        <div class="file-header">
          <h4>docker-compose.yml</h4>
          <button @click="copyToClipboard(dockerComposeYaml)" class="copy-btn">
            {{ copiedDockerCompose ? 'Copied!' : 'Copy' }}
          </button>
        </div>
        <pre class="code-block"><code>{{ dockerComposeYaml }}</code></pre>
      </div>

      <div class="file-output">
        <div class="file-header">
          <h4>.env</h4>
          <button @click="copyToClipboard(envFile)" class="copy-btn">
            {{ copiedEnv ? 'Copied!' : 'Copy' }}
          </button>
        </div>
        <pre class="code-block"><code>{{ envFile }}</code></pre>
      </div>

      <div class="instructions">
        <h4>Deployment Instructions</h4>
        <ol>
          <li>Copy the <code>docker-compose.yml</code> content above and save it to a file named <code>docker-compose.yml</code></li>
          <li>Copy the <code>.env</code> content above and save it to a file named <code>.env</code> in the same directory</li>
          <li v-if="config.deploymentMode !== 'development'">
            Generate a secure session secret: <code>openssl rand -base64 32</code> and update it in the .env file
          </li>
          <li>Run <code>docker compose up -d</code> to start MeshMonitor</li>
          <li>Access MeshMonitor at {{ accessUrl }}</li>
        </ol>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const config = ref({
  connectionType: 'tcp',
  nodeIp: '192.168.1.100',
  nodePort: 4403,
  bleMac: '',
  serialDevice: '/dev/ttyUSB0',
  baudRate: 115200,
  deploymentMode: 'development',
  hostname: '',
  useHttps: true,
  webPort: 8080,
  enableVirtualNode: true,
  virtualNodePort: 4404,
  disableAnonymous: false,
  timezone: 'America/New_York'
})

const copiedDockerCompose = ref(false)
const copiedEnv = ref(false)

const accessUrl = computed(() => {
  if (config.value.deploymentMode === 'production-proxy') {
    const protocol = config.value.useHttps ? 'https' : 'http'
    return `${protocol}://${config.value.hostname || 'yourdomain.com'}`
  }
  return `http://localhost:${config.value.webPort}`
})

const dockerComposeYaml = computed(() => {
  const lines = ['services:']

  // Add bridge services if needed
  if (config.value.connectionType === 'ble') {
    lines.push('  ble-bridge:')
    lines.push('    image: ghcr.io/yeraze/meshtastic-ble-bridge:latest')
    lines.push('    container_name: meshmonitor-ble-bridge')
    lines.push('    privileged: true')
    lines.push('    network_mode: host')
    lines.push('    restart: unless-stopped')
    lines.push('    volumes:')
    lines.push('      - /var/run/dbus:/var/run/dbus')
    lines.push('      - /var/lib/bluetooth:/var/lib/bluetooth:ro')
    lines.push('    environment:')
    lines.push('      - BLE_ADDRESS=${BLE_ADDRESS}')
    lines.push('    command: ${BLE_ADDRESS}')
    lines.push('    healthcheck:')
    lines.push('      test: ["CMD-SHELL", "netstat -tln | grep -q :4403 || exit 1"]')
    lines.push('      interval: 30s')
    lines.push('      timeout: 10s')
    lines.push('      retries: 3')
    lines.push('      start_period: 10s')
    lines.push('')
  } else if (config.value.connectionType === 'serial') {
    lines.push('  serial-bridge:')
    lines.push('    image: ghcr.io/yeraze/meshtastic-serial-bridge:latest')
    lines.push('    container_name: meshtastic-serial-bridge')
    lines.push('    devices:')
    lines.push(`      - ${config.value.serialDevice}:${config.value.serialDevice}`)
    lines.push('    ports:')
    lines.push('      - "4403:4403"')
    lines.push('    restart: unless-stopped')
    lines.push('    environment:')
    lines.push(`      - SERIAL_DEVICE=${config.value.serialDevice}`)
    lines.push(`      - BAUD_RATE=${config.value.baudRate}`)
    lines.push('      - TCP_PORT=4403')
    lines.push('')
  }

  // MeshMonitor service
  lines.push('  meshmonitor:')
  lines.push('    image: ghcr.io/yeraze/meshmonitor:latest')
  lines.push('    container_name: meshmonitor')
  lines.push('    ports:')
  lines.push(`      - "${config.value.webPort}:3001"`)
  if (config.value.enableVirtualNode && config.value.connectionType !== 'ble') {
    lines.push(`      - "${config.value.virtualNodePort}:${config.value.virtualNodePort}"`)
  }
  lines.push('    restart: unless-stopped')
  lines.push('    volumes:')
  lines.push('      - meshmonitor-data:/data')
  lines.push('    env_file: .env')
  lines.push('    environment:')

  // Node environment
  if (config.value.deploymentMode === 'development') {
    lines.push('      - NODE_ENV=development')
  } else {
    lines.push('      - NODE_ENV=production')
  }

  lines.push(`      - TZ=${config.value.timezone}`)

  // Connection settings
  if (config.value.connectionType === 'tcp') {
    lines.push(`      - MESHTASTIC_NODE_IP=${config.value.nodeIp}`)
    if (config.value.nodePort !== 4403) {
      lines.push(`      - MESHTASTIC_NODE_PORT=${config.value.nodePort}`)
    }
  } else {
    lines.push('      - MESHTASTIC_NODE_IP=localhost')
  }

  // Production settings
  if (config.value.deploymentMode === 'production-proxy') {
    lines.push('      - TRUST_PROXY=true')
    if (config.value.useHttps) {
      lines.push('      - COOKIE_SECURE=true')
    }
    const protocol = config.value.useHttps ? 'https' : 'http'
    lines.push(`      - ALLOWED_ORIGINS=${protocol}://${config.value.hostname}`)
  } else if (config.value.deploymentMode === 'production-http') {
    lines.push('      - COOKIE_SECURE=false')
    lines.push(`      - ALLOWED_ORIGINS=http://localhost:${config.value.webPort}`)
  } else {
    lines.push(`      - ALLOWED_ORIGINS=http://localhost:${config.value.webPort}`)
  }

  // Virtual Node
  if (config.value.enableVirtualNode) {
    lines.push('      - ENABLE_VIRTUAL_NODE=true')
    if (config.value.virtualNodePort !== 4404) {
      lines.push(`      - VIRTUAL_NODE_PORT=${config.value.virtualNodePort}`)
    }
  }

  // Disable Anonymous
  if (config.value.disableAnonymous) {
    lines.push('      - DISABLE_ANONYMOUS=true')
  }

  // Dependencies
  if (config.value.connectionType === 'ble') {
    lines.push('    depends_on:')
    lines.push('      ble-bridge:')
    lines.push('        condition: service_healthy')
  } else if (config.value.connectionType === 'serial') {
    lines.push('    depends_on:')
    lines.push('      - serial-bridge')
  }

  lines.push('')
  lines.push('volumes:')
  lines.push('  meshmonitor-data:')
  lines.push('    driver: local')

  return lines.join('\n')
})

const envFile = computed(() => {
  const lines = ['# MeshMonitor Configuration']
  lines.push('# Generated by MeshMonitor Docker Compose Configurator')
  lines.push('')

  // Connection settings
  if (config.value.connectionType === 'tcp') {
    lines.push('# Meshtastic Node Connection')
    lines.push(`MESHTASTIC_NODE_IP=${config.value.nodeIp}`)
    if (config.value.nodePort !== 4403) {
      lines.push(`MESHTASTIC_NODE_PORT=${config.value.nodePort}`)
    }
  } else if (config.value.connectionType === 'ble') {
    lines.push('# BLE Bridge Configuration')
    lines.push(`BLE_ADDRESS=${config.value.bleMac || 'AA:BB:CC:DD:EE:FF'}`)
  } else if (config.value.connectionType === 'serial') {
    lines.push('# Serial Bridge Configuration')
    lines.push(`SERIAL_DEVICE=${config.value.serialDevice}`)
    lines.push(`BAUD_RATE=${config.value.baudRate}`)
  }

  lines.push('')

  // Production session secret
  if (config.value.deploymentMode !== 'development') {
    lines.push('# IMPORTANT: Generate a secure session secret!')
    lines.push('# Run: openssl rand -base64 32')
    lines.push('SESSION_SECRET=REPLACE_WITH_SECURE_RANDOM_STRING')
    lines.push('')
  }

  // Virtual Node
  if (config.value.enableVirtualNode) {
    lines.push('# Virtual Node Configuration')
    lines.push('ENABLE_VIRTUAL_NODE=true')
    if (config.value.virtualNodePort !== 4404) {
      lines.push(`VIRTUAL_NODE_PORT=${config.value.virtualNodePort}`)
    }
    lines.push('')
  }

  // Authentication
  if (config.value.disableAnonymous) {
    lines.push('# Authentication')
    lines.push('DISABLE_ANONYMOUS=true')
    lines.push('')
  }

  return lines.join('\n')
})

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    if (text === dockerComposeYaml.value) {
      copiedDockerCompose.value = true
      setTimeout(() => { copiedDockerCompose.value = false }, 2000)
    } else {
      copiedEnv.value = true
      setTimeout(() => { copiedEnv.value = false }, 2000)
    }
  } catch (err) {
    console.error('Failed to copy:', err)
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
  border-bottom: 2px solid var(--vp-c-brand);
  padding-bottom: 0.5rem;
}

.help-text {
  color: var(--vp-c-text-2);
  margin-bottom: 1rem;
  font-size: 0.95rem;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.radio-option {
  display: flex;
  align-items: flex-start;
  padding: 1rem;
  border: 2px solid var(--vp-c-divider);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.radio-option:hover {
  border-color: var(--vp-c-brand);
  background-color: var(--vp-c-bg);
}

.radio-option.selected {
  border-color: var(--vp-c-brand);
  background-color: var(--vp-c-bg);
}

.radio-option input[type="radio"] {
  margin-right: 0.75rem;
  margin-top: 0.25rem;
  cursor: pointer;
}

.option-content {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.option-desc {
  font-size: 0.9rem;
  color: var(--vp-c-text-2);
  margin-top: 0.25rem;
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
}

.text-input:focus {
  outline: none;
  border-color: var(--vp-c-brand);
}

.field-help {
  font-size: 0.85rem;
  color: var(--vp-c-text-2);
  margin-top: 0.25rem;
  margin-bottom: 1rem;
}

.field-help code {
  font-size: 0.8rem;
  padding: 0.1rem 0.3rem;
  background-color: var(--vp-c-bg-soft);
  border-radius: 3px;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 1rem;
}

.checkbox-option {
  display: flex;
  align-items: flex-start;
  cursor: pointer;
  padding: 0.75rem;
  border-radius: 6px;
  transition: background-color 0.2s;
}

.checkbox-option:hover {
  background-color: var(--vp-c-bg);
}

.checkbox-option input[type="checkbox"] {
  margin-right: 0.75rem;
  margin-top: 0.25rem;
  cursor: pointer;
}

.results {
  background-color: var(--vp-c-bg);
  border: 2px solid var(--vp-c-brand);
}

.file-output {
  margin-bottom: 2rem;
}

.file-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.file-header h4 {
  margin: 0;
  font-family: var(--vp-font-family-mono);
}

.copy-btn {
  padding: 0.4rem 1rem;
  background-color: var(--vp-c-brand);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background-color 0.2s;
}

.copy-btn:hover {
  background-color: var(--vp-c-brand-dark);
}

.code-block {
  background-color: var(--vp-code-block-bg);
  padding: 1rem;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 0.9rem;
  line-height: 1.5;
}

.code-block code {
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
}

.instructions {
  margin-top: 2rem;
  padding: 1.5rem;
  background-color: var(--vp-c-bg-soft);
  border-radius: 6px;
  border-left: 4px solid var(--vp-c-brand);
}

.instructions h4 {
  margin-top: 0;
  margin-bottom: 1rem;
}

.instructions ol {
  margin: 0;
  padding-left: 1.5rem;
}

.instructions li {
  margin-bottom: 0.75rem;
}

.instructions code {
  font-size: 0.9rem;
  padding: 0.1rem 0.4rem;
  background-color: var(--vp-code-bg);
  border-radius: 3px;
}
</style>
