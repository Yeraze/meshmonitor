/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MESHTASTIC_NODE_IP: string
  readonly VITE_MESHTASTIC_USE_TLS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}