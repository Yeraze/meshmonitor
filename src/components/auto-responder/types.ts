import { Channel } from '../../types/device';

/**
 * Script metadata from the API
 */
export interface ScriptMetadata {
  path: string;           // Full path like /data/scripts/filename.py
  filename: string;       // Just the filename
  name?: string;          // Human-readable name from mm_meta
  emoji?: string;         // Emoji icon from mm_meta
  language: string;       // Inferred from extension or mm_meta
}

export type ResponseType = 'text' | 'http' | 'script';

export interface AutoResponderTrigger {
  id: string;
  trigger: string | string[]; // Single pattern or array of patterns (e.g., "ask" or ["ask", "ask {message}"])
  responseType: ResponseType;
  response: string; // Either text content, HTTP URL, or script path
  multiline?: boolean; // Enable multiline support for text/http responses
  verifyResponse?: boolean; // Enable retry logic (3 attempts) for this trigger (DM only)
  channels?: Array<number | 'dm' | 'none'>; // Channel indexes (0-7), 'dm' for direct messages, or 'none' for scripts with no mesh output
  /** @deprecated Use channels instead. Kept for backward compatibility during migration. */
  channel?: number | 'dm' | 'none';
  scriptArgs?: string; // Optional CLI arguments for script execution (supports token expansion)
}

export type TimerResponseType = 'script' | 'text';

export interface TimerTrigger {
  id: string;
  name: string; // Human-readable name for this timer
  cronExpression: string; // Cron expression (e.g., "0 */6 * * *")
  responseType?: TimerResponseType; // 'script' (default) or 'text' message
  scriptPath?: string; // Path to script in /data/scripts/ (when responseType is 'script')
  response?: string; // Text message with expansion tokens (when responseType is 'text')
  scriptArgs?: string; // Optional CLI arguments for script execution (supports token expansion)
  channel: number | 'none'; // Channel index (0-7) to send output to, or 'none' for scripts with no mesh output
  enabled: boolean; // Whether this timer is active
  lastRun?: number; // Unix timestamp of last execution
  lastResult?: 'success' | 'error'; // Result of last execution
  lastError?: string; // Error message if last run failed
}

export type GeofenceShapeCircle = {
  type: 'circle';
  center: { lat: number; lng: number };
  radiusKm: number;
};

export type GeofenceShapePolygon = {
  type: 'polygon';
  vertices: Array<{ lat: number; lng: number }>;
};

export type GeofenceShape = GeofenceShapeCircle | GeofenceShapePolygon;

export type GeofenceEvent = 'entry' | 'exit' | 'while_inside';

export type GeofenceNodeFilter =
  | { type: 'all' }
  | { type: 'selected'; nodeNums: number[] };

export type GeofenceResponseType = 'text' | 'script';

export interface GeofenceTrigger {
  id: string;
  name: string;
  enabled: boolean;
  shape: GeofenceShape;
  event: GeofenceEvent;
  whileInsideIntervalMinutes?: number; // Required when event is 'while_inside'
  nodeFilter: GeofenceNodeFilter;
  responseType: GeofenceResponseType;
  response?: string; // Text message with expansion tokens (when responseType is 'text')
  scriptPath?: string; // Path to script in /data/scripts/ (when responseType is 'script')
  scriptArgs?: string; // Optional CLI arguments for script execution (supports token expansion)
  channel: number | 'dm' | 'none'; // Channel index (0-7), 'dm' for direct message, or 'none' for scripts with no mesh output
  verifyResponse?: boolean; // Enable retry logic (3 attempts) for DM messages
  lastRun?: number; // Unix timestamp of last execution
  lastResult?: 'success' | 'error';
  lastError?: string;
}

export interface AutoResponderSectionProps {
  enabled: boolean;
  triggers: AutoResponderTrigger[];
  channels: Channel[];
  skipIncompleteNodes: boolean;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onTriggersChange: (triggers: AutoResponderTrigger[]) => void;
  onSkipIncompleteNodesChange: (enabled: boolean) => void;
}

export interface TriggerItemProps {
  trigger: AutoResponderTrigger;
  isEditing: boolean;
  localEnabled: boolean;
  availableScripts: ScriptMetadata[];
  channels: Channel[];
  baseUrl: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (trigger: string | string[], responseType: ResponseType, response: string, multiline: boolean, verifyResponse: boolean, channels: Array<number | 'dm' | 'none'>, scriptArgs?: string) => void;
  onRemove: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
}

