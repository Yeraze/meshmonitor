import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';

class ApiService {
  private baseUrl = '';

  async getConfig() {
    const response = await fetch(`${this.baseUrl}/api/config`);
    if (!response.ok) throw new Error('Failed to fetch config');
    return response.json();
  }

  async getDeviceConfig() {
    const response = await fetch(`${this.baseUrl}/api/device-config`);
    if (!response.ok) throw new Error('Failed to fetch device config');
    return response.json();
  }

  async getConnectionStatus() {
    const response = await fetch(`${this.baseUrl}/api/connection`);
    if (!response.ok) throw new Error('Failed to fetch connection status');
    return response.json();
  }

  async getSystemStatus() {
    const response = await fetch(`${this.baseUrl}/api/system/status`);
    if (!response.ok) throw new Error('Failed to fetch system status');
    return response.json();
  }

  async getNodes(): Promise<DeviceInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/nodes`);
    if (!response.ok) throw new Error('Failed to fetch nodes');
    const data = await response.json();
    return data.nodes || [];
  }

  async refreshNodes() {
    const response = await fetch(`${this.baseUrl}/api/nodes/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Failed to refresh nodes');
    return response.json();
  }

  async getChannels(): Promise<Channel[]> {
    const response = await fetch(`${this.baseUrl}/api/channels`);
    if (!response.ok) throw new Error('Failed to fetch channels');
    const data = await response.json();
    return data.channels || [];
  }

  async getMessages(limit: number = 100): Promise<MeshMessage[]> {
    const response = await fetch(`${this.baseUrl}/api/messages?limit=${limit}`);
    if (!response.ok) throw new Error('Failed to fetch messages');
    const data = await response.json();
    return data.messages || [];
  }

  async sendMessage(payload: {
    channel?: number;
    text: string;
    destination?: string;
  }): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to send message');
    }

    return response.json();
  }

  async sendTraceroute(nodeId: string) {
    const response = await fetch(`${this.baseUrl}/api/traceroute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: nodeId }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to send traceroute');
    }

    return response.json();
  }

  async getRecentTraceroutes() {
    const response = await fetch(`${this.baseUrl}/api/traceroutes/recent`);
    if (!response.ok) throw new Error('Failed to fetch traceroutes');
    return response.json();
  }

  async getNodesWithTelemetry(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/telemetry/available/nodes`);
    if (!response.ok) throw new Error('Failed to fetch telemetry nodes');
    const data = await response.json();
    return data.nodes || [];
  }

  async updateTracerouteInterval(minutes: number) {
    const response = await fetch(`${this.baseUrl}/api/settings/traceroute-interval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMinutes: minutes }),
    });

    if (!response.ok) {
      throw new Error('Failed to update traceroute interval');
    }

    return response.json();
  }

  async purgeNodes(olderThanHours: number) {
    const response = await fetch(`${this.baseUrl}/api/purge/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanHours }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to purge nodes');
    }

    return response.json();
  }

  async purgeTelemetry(olderThanHours: number) {
    const response = await fetch(`${this.baseUrl}/api/purge/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanHours }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to purge telemetry');
    }

    return response.json();
  }

  async purgeMessages(olderThanHours: number) {
    const response = await fetch(`${this.baseUrl}/api/purge/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanHours }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to purge messages');
    }

    return response.json();
  }
}

export default new ApiService();