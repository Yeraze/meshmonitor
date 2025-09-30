import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import {
  sanitizeTextInput,
  validateChannel,
  validateNodeId,
  validateHours,
  validateIntervalMinutes
} from '../utils/validation';

class ApiService {
  private baseUrl = '';
  private configFetched = false;

  private async ensureBaseUrl() {
    if (!this.configFetched) {
      try {
        // Get the base path from the current location
        // If we're at /meshmonitor/something, extract /meshmonitor
        const pathname = window.location.pathname;
        const pathParts = pathname.split('/').filter(Boolean);

        // Try to determine if we're running under a base path
        let potentialBase = '';

        // First try to fetch config from root
        let response = await fetch('/api/config');

        // If that fails and we're not at root, try with a potential base path
        if (!response.ok && pathParts.length > 0) {
          potentialBase = '/' + pathParts[0];
          response = await fetch(`${potentialBase}/api/config`);
        }

        if (response.ok) {
          const config = await response.json();
          this.baseUrl = config.baseUrl || potentialBase || '';
          this.configFetched = true;
        } else {
          this.baseUrl = potentialBase || '';
          this.configFetched = true;
        }
      } catch (error) {
        // Fallback to no base URL if config fetch fails
        console.warn('Failed to fetch initial config, using default base URL');
        this.baseUrl = '';
        this.configFetched = true;
      }
    }
  }

  async getConfig() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config`);
    if (!response.ok) throw new Error('Failed to fetch config');
    return response.json();
  }

  async getDeviceConfig() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/device-config`);
    if (!response.ok) throw new Error('Failed to fetch device config');
    return response.json();
  }

  async getConnectionStatus() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/connection`);
    if (!response.ok) throw new Error('Failed to fetch connection status');
    return response.json();
  }

  async getSystemStatus() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/system/status`);
    if (!response.ok) throw new Error('Failed to fetch system status');
    return response.json();
  }

  async getNodes(): Promise<DeviceInfo[]> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/nodes`);
    if (!response.ok) throw new Error('Failed to fetch nodes');
    const data = await response.json();
    return data.nodes || [];
  }

  async refreshNodes() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/nodes/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error('Failed to refresh nodes');
    return response.json();
  }

  async getChannels(): Promise<Channel[]> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/channels`);
    if (!response.ok) throw new Error('Failed to fetch channels');
    const data = await response.json();
    return data.channels || [];
  }

  async getMessages(limit: number = 100): Promise<MeshMessage[]> {
    await this.ensureBaseUrl();
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
    // Validate and sanitize inputs
    const sanitizedPayload = {
      channel: validateChannel(payload.channel),
      text: sanitizeTextInput(payload.text),
      destination: validateNodeId(payload.destination)
    };

    if (!sanitizedPayload.text) {
      throw new Error('Message text cannot be empty');
    }

    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitizedPayload),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to send message');
    }

    return response.json();
  }

  async sendTraceroute(nodeId: string) {
    // Validate node ID format
    const validatedNodeId = validateNodeId(nodeId);
    if (!validatedNodeId) {
      throw new Error('Invalid node ID provided for traceroute');
    }

    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/traceroute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: validatedNodeId }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to send traceroute');
    }

    return response.json();
  }

  async getRecentTraceroutes() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/traceroutes/recent`);
    if (!response.ok) throw new Error('Failed to fetch traceroutes');
    return response.json();
  }

  async getNodesWithTelemetry(): Promise<string[]> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/telemetry/available/nodes`);
    if (!response.ok) throw new Error('Failed to fetch telemetry nodes');
    const data = await response.json();
    return data.nodes || [];
  }

  async updateTracerouteInterval(minutes: number) {
    // Validate interval minutes
    const validatedMinutes = validateIntervalMinutes(minutes);

    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/settings/traceroute-interval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMinutes: validatedMinutes }),
    });

    if (!response.ok) {
      throw new Error('Failed to update traceroute interval');
    }

    return response.json();
  }

  async purgeNodes(olderThanHours: number) {
    // Validate hours parameter
    const validatedHours = validateHours(olderThanHours);

    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/purge/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanHours: validatedHours }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to purge nodes');
    }

    return response.json();
  }

  async purgeTelemetry(olderThanHours: number) {
    // Validate hours parameter
    const validatedHours = validateHours(olderThanHours);

    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/purge/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanHours: validatedHours }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to purge telemetry');
    }

    return response.json();
  }

  async purgeMessages(olderThanHours: number) {
    // Validate hours parameter
    const validatedHours = validateHours(olderThanHours);

    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/purge/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanHours: validatedHours }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to purge messages');
    }

    return response.json();
  }
}

export default new ApiService();