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

  // Get CSRF token from sessionStorage
  private getCsrfToken(): string | null {
    return sessionStorage.getItem('csrfToken');
  }

  // Get headers with CSRF token for mutation requests
  private getHeadersWithCsrf(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const csrfToken = this.getCsrfToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
      console.log('[API] ✓ CSRF token added to headers');
    } else {
      console.error('[API] ✗ NO CSRF TOKEN - Request may fail!');
    }

    return headers;
  }

  // Refresh CSRF token
  private async refreshCsrfToken(): Promise<string> {
    logger.debug('Refreshing CSRF token...');
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/csrf-token`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error('Failed to refresh CSRF token');
    }

    const data = await response.json();
    const token = data.csrfToken;
    sessionStorage.setItem('csrfToken', token);
    return token;
  }

  // Generic request method with credentials and CSRF token
  async request<T>(
    method: string,
    endpoint: string,
    body?: any,
    retryCount = 0
  ): Promise<T> {
    await this.ensureBaseUrl();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add CSRF token for mutation requests
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
      const csrfToken = this.getCsrfToken();
      const tokenStatus = csrfToken ? `Found (${csrfToken.substring(0,8)}...)` : 'NOT FOUND';
      console.log(`[API] ${method} ${endpoint} - CSRF token:`, tokenStatus);

      // Also check sessionStorage directly
      const directCheck = sessionStorage.getItem('csrfToken');
      console.log('[API] Direct sessionStorage check:', directCheck ? 'EXISTS' : 'MISSING');

      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
        console.log('[API] ✓ X-CSRF-Token header added');
      } else {
        console.error('[API] ✗ NO CSRF TOKEN - Request will fail!');
      }
    }

    const options: RequestInit = {
      method,
      headers,
      credentials: 'include', // Include cookies for session management
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${endpoint}`, options);

    // Handle CSRF token errors with retry
    if (response.status === 403 && retryCount < 1) {
      const error = await response.json().catch(() => ({ error: '' }));
      if (error.error && error.error.toLowerCase().includes('csrf')) {
        logger.warn('CSRF token invalid, refreshing and retrying...');
        await this.refreshCsrfToken();
        return this.request<T>(method, endpoint, body, retryCount + 1);
      }
    }

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

        // Skip if we're on an API route (like /api/auth/oidc/callback)
        // These should never be used as base paths
        if (pathParts.length > 0 && pathParts[0] === 'api') {
          // We're on an API route, just try root config
          const potentialPaths: string[] = ['/api/config'];

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

          // Default to no base URL if we're on an API route
          this.baseUrl = '';
          this.configFetched = true;
          return;
        }

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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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

  async getAllChannels(): Promise<Channel[]> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/channels/all`);
    if (!response.ok) throw new Error('Failed to fetch all channels');
    return response.json();
  }

  async updateChannel(channelId: number, channelData: {
    name: string;
    psk?: string;
    role?: number;
    uplinkEnabled?: boolean;
    downlinkEnabled?: boolean;
    positionPrecision?: number;
  }): Promise<Channel> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/channels/${channelId}`, {
      method: 'PUT',
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
      body: JSON.stringify(channelData),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update channel');
    }

    const result = await response.json();
    return result.channel;
  }

  async exportChannel(channelId: number): Promise<void> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/channels/${channelId}/export`, {
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to export channel');
    }

    // Get filename from Content-Disposition header or create default
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = `channel-${channelId}-${Date.now()}.json`;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
      if (filenameMatch) {
        filename = filenameMatch[1];
      }
    }

    // Download the file
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  async importChannel(slotId: number, channelData: any): Promise<Channel> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/channels/${slotId}/import`, {
      method: 'POST',
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
      body: JSON.stringify({ channel: channelData }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to import channel');
    }

    const result = await response.json();
    return result.channel;
  }

  async decodeChannelUrl(url: string): Promise<any> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/channels/decode-url`, {
      method: 'POST',
      headers: this.getHeadersWithCsrf(),
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to decode channel URL');
    }

    return response.json();
  }

  async encodeChannelUrl(channelIds: number[], includeLoraConfig: boolean): Promise<string> {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/channels/encode-url`, {
      method: 'POST',
      headers: this.getHeadersWithCsrf(),
      body: JSON.stringify({ channelIds, includeLoraConfig }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to encode channel URL');
    }

    const result = await response.json();
    return result.url;
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include',
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
      headers: this.getHeadersWithCsrf(),
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to restart/shutdown');
    }

    return response.json();
  }

  // Connection control methods
  async disconnectFromNode() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/connection/disconnect`, {
      method: 'POST',
      headers: this.getHeadersWithCsrf(),
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to disconnect');
    }

    return response.json();
  }

  async reconnectToNode() {
    await this.ensureBaseUrl();
    const response = await fetch(`${this.baseUrl}/api/connection/reconnect`, {
      method: 'POST',
      headers: this.getHeadersWithCsrf(),
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to reconnect');
    }

    return response.json();
  }
}

export default new ApiService();