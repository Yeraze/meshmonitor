import { Channel } from '../../types/device';

export type ResponseType = 'text' | 'http' | 'script';

export interface AutoResponderTrigger {
  id: string;
  trigger: string | string[]; // Single pattern or array of patterns (e.g., "ask" or ["ask", "ask {message}"])
  responseType: ResponseType;
  response: string; // Either text content, HTTP URL, or script path
  multiline?: boolean; // Enable multiline support for text/http responses
  verifyResponse?: boolean; // Enable retry logic (3 attempts) for this trigger (DM only)
  channel?: number | 'dm'; // Channel index (0-7) or 'dm' for direct messages (default: 'dm')
}

export interface TimerTrigger {
  id: string;
  name: string; // Human-readable name for this timer
  cronExpression: string; // Cron expression (e.g., "0 */6 * * *")
  scriptPath: string; // Path to script in /data/scripts/
  channel: number; // Channel index (0-7) to send script output to
  enabled: boolean; // Whether this timer is active
  lastRun?: number; // Unix timestamp of last execution
  lastResult?: 'success' | 'error'; // Result of last execution
  lastError?: string; // Error message if last run failed
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
  availableScripts: string[];
  channels: Channel[];
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (trigger: string | string[], responseType: ResponseType, response: string, multiline: boolean, verifyResponse: boolean, channel: number | 'dm') => void;
  onRemove: () => void;
  showToast?: (message: string, type: 'success' | 'error' | 'warning') => void;
}

