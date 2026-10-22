import type { ScopeMode } from './ScopeSelectField';
import type { ResponderSyntax } from '../../utils/responderTrigger';

/**
 * Mirrors the backend `MeshCoreAutoResponderTrigger` shape. Kept inline
 * for the same reason as the timer trigger: it's a server-only type
 * that crosses the wire as JSON.
 */
export interface MeshCoreAutoResponderTrigger {
  id: string;
  name: string;
  enabled: boolean;
  pattern: string;
  /**
   * How `pattern` is read (#5924): `'pattern'` (placeholder DSL) or
   * `'regex'`. Missing = `'regex'`, the pre-#5924 behaviour.
   */
  syntax?: ResponderSyntax;
  /**
   * `text` (default) sends `response`; `script` runs `scriptPath` and
   * sends each entry of the script's wouldSendMessages output.
   */
  responseType?: 'text' | 'script';
  response: string;
  scriptPath?: string;
  scriptArgs?: string;
  channels: number[];
  listenDMs: boolean;
  replyAsDM: boolean;
  cooldownSeconds: number;
  /** Delay (s) after a match before sending the reply. 0 = immediate, max 120 (#3953). */
  preSendDelaySeconds?: number;
  /** MeshCore scope/region for the reply (#3833). */
  scopeMode?: ScopeMode;
  scopeName?: string;
}

export interface MeshCoreScriptMetadata {
  path: string;
  filename: string;
  name?: string;
  emoji?: string;
  language?: string;
}

export interface MeshCoreChannelRow {
  id: number;
  name: string;
}
