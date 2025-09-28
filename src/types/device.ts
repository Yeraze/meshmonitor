export interface DeviceInfo {
  nodeNum: number
  user?: {
    id: string
    longName: string
    shortName: string
    hwModel?: number
    role?: string
  }
  position?: {
    latitude: number
    longitude: number
    altitude?: number
  }
  deviceMetrics?: {
    batteryLevel?: number
    voltage?: number
    channelUtilization?: number
    airUtilTx?: number
  }
  hopsAway?: number
  lastHeard?: number
  snr?: number
  rssi?: number
}

export interface Channel {
  id: number
  name: string
  psk?: string
  uplinkEnabled: boolean
  downlinkEnabled: boolean
  createdAt: number
  updatedAt: number
}