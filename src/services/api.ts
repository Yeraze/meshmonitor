import { DeviceInfo, Channel } from '../types/device';
import { MeshMessage } from '../types/message';
import {
  sanitizeTextInput,
  validateChannel,
  validateNodeId,
  validateHours,
  validateIntervalMinutes
} from '../utils/validation';
import { logger } from '../utils/logger.js';

class ApiService {
  private baseUrl = '';
  private configFetched = false;
  private configPromise: Promise<void> | null = null;

  // Generic request method with credentials for session cookies
  async request<T>(
    method: string,
    endpoint: string,
    body?: any
  ): Promise<T> {
    await this.ensureBaseUrl();

    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // Include cookies for session management
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, options);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `Request failed with status ${response.status}`);
    }

    return response.json();
  }

  // Generic GET method
  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>('GET', endpoint);
  }

  // Generic POST method
  async post<T>(endpoint: string, body?: any): Promise<T> {
    return this.request<T>('POST', endpoint, body);
  }

  // Generic PUT method
  async put<T>(endpoint: string, body?: any): Promise<T> {
    return this.request<T>('PUT', endpoint, body);
  }

  // Generic DELETE method
  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>('DELETE', endpoint);
  }

  /**
   * Set the base URL directly, skipping auto-detection
   * Useful when the app already knows the base path from pathname
   */
  public setBaseUrl(url: string) {
    this.baseUrl = url;
    this.configFetched = true; // Skip auto-detection
  }

  private async ensureBaseUrl() {
    // If config is already fetched, return immediately
    if (this.configFetched) {
      return;
    }

    // If a config fetch is already in progress, wait for it
    if (this.configPromise) {
      return this.configPromise;
    }

    // Start the config fetch and store the promise for deduplication
    this.configPromise = this.fetchConfigWithRetry();

    try {
      await this.configPromise;
    } finally {
      // Clear the promise after completion (success or failure)
      this.configPromise = null;
    }
  }

  private async fetchConfigWithRetry(maxRetries = 3): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Get the base path from the current location
        const pathname = window.location.pathname;
        const pathParts = pathname.split('/').filter(Boolean);

        // Build potential base paths from multiple segments
        // For /company/tools/meshmonitor, try:
        // 1. /api/config (root)
        // 2. /company/tools/meshmonitor/api/config
        // 3. /company/tools/api/config
        // 4. /company/api/config
        const potentialPaths: string[] = ['/api/config'];

        // Add paths from most specific to least specific
        for (let i = pathParts.length; i > 0; i--) {
          const basePath = '/' + pathParts.slice(0, i).join('/');
          potentialPaths.push(`${basePath}/api/config`);
        }

        // Try each potential path
        for (const configPath of potentialPaths) {
          try {
            const response = await fetch(configPath);

            if (response.ok) {
              // Check content type to ensure we got JSON, not HTML
              const contentType = response.headers.get('content-type');
              if (contentType && contentType.includes('application/json')) {
                const config = await response.json();
                this.baseUrl = config.baseUrl || '';
                this.configFetched = true;
                return; // Success, exit
              }
            }
          } catch {
            // Continue to next path
            continue;
          }
        }

        // If no config endpoint worked but we have path segments,
        // use the full path as the base URL (most likely scenario)
        if (pathParts.length > 0) {
          // Remove any trailing segments that look like app routes (not part of base path)
          // Keep segments until we hit something that looks like a route
          const appRoutes = ['nodes', 'channels', 'messages', 'settings', 'info', 'dashboard'];
          let baseSegments = [];

          for (const segment of pathParts) {
            if (appRoutes.includes(segment.toLowerCase())) {
              break; // Stop at app routes
            }
            baseSegments.push(segment);
          }

          if (baseSegments.length > 0) {
            this.baseUrl = '/' + baseSegments.join('/');
            this.configFetched = true;
            logger.warn(`Using inferred base URL: ${this.baseUrl}`);
            return;
          }
        }

        // Default to no base URL
        this.baseUrl = '';
        this.configFetched = true;
        return;

      } catch (error) {
        lastError = error as Error;

        // Wait before retrying (exponential backoff)
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
      }
    }

    // All retries failed, use fallback
    logger.warn('Failed to fetch config after retries, using default base URL', lastError);
    this.baseUrl = '';
    this.configFetched = true;
  }

  async getConfig() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config`);
    if (!response.ok) throw new Error('Failed to fetch config');

    // Verify we got JSON, not HTML
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('Config endpoint returned non-JSON response');
    }

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

  async getBaseUrl(): Promise<string> {
    await this.ensureBaseUrl();
    return this.baseUrl;
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

  async getLongestActiveRouteSegment() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/route-segments/longest-active`);

    if (!response.ok) {
      throw new Error('Failed to fetch longest active route segment');
    }

    return response.json();
  }

  async getRecordHolderRouteSegment() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/route-segments/record-holder`);

    if (!response.ok) {
      throw new Error('Failed to fetch record holder route segment');
    }

    return response.json();
  }

  async clearRecordHolderSegment() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/route-segments/record-holder`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to clear record holder');
    }

    return response.json();
  }

  // Configuration methods
  async getCurrentConfig() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/current`);
    if (!response.ok) throw new Error('Failed to fetch current configuration');
    return response.json();
  }

  async setDeviceConfig(config: any) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to set device configuration');
    }

    return response.json();
  }

  async setLoRaConfig(config: any) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/lora`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to set LoRa configuration');
    }

    return response.json();
  }

  async setPositionConfig(config: any) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to set position configuration');
    }

    return response.json();
  }

  async setMQTTConfig(config: any) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/mqtt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to set MQTT configuration');
    }

    return response.json();
  }

  async setNeighborInfoConfig(config: any) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/neighborinfo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to set NeighborInfo configuration');
    }

    return response.json();
  }

  async setNodeOwner(longName: string, shortName: string) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ longName, shortName }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to set node owner');
    }

    return response.json();
  }

  async requestConfig(configType: number) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configType }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to request configuration');
    }

    return response.json();
  }

  async requestModuleConfig(configType: number) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/config/module/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configType }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to request module configuration');
    }

    return response.json();
  }

  async rebootDevice(seconds: number = 5) {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/device/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to reboot device');
    }

    return response.json();
  }

  async restartContainer() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/system/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to restart/shutdown');
    }

    return response.json();
  }
}

export default new ApiService();