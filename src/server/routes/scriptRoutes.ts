import express, { Request, Response, Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { scriptDependencyEnv } from '../utils/scriptRunner.js';
import { compileUserRegex } from '../../utils/safeRegex.js';
import { normalizeTriggerPatterns } from '../../utils/autoResponderUtils.js';
import { safeFetch, SsrfBlockedError } from '../utils/ssrfGuard.js';
import { getDependencyStatus, installDependencies } from '../services/scriptDependencyService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = getEnvironmentConfig();

/**
 * Gets the scripts directory path.
 * In development, uses relative path from project root (data/scripts).
 * In production, uses DATA_DIR env var (set by desktop sidecar) or defaults to /data.
 */
export const getScriptsDirectory = (): string => {
  let scriptsDir: string;

  if (env.isDevelopment) {
    // __dirname here is src/server/routes; the project root is three levels up
    // (vs. two from server.ts) so the resolved path matches the original helper.
    const projectRoot = path.resolve(__dirname, '../../../');
    scriptsDir = path.join(projectRoot, 'data', 'scripts');
  } else {
    scriptsDir = path.join(process.env.DATA_DIR || '/data', 'scripts');
  }

  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
    logger.debug(`📁 Created scripts directory: ${scriptsDir}`);
  }

  return scriptsDir;
};

/**
 * Converts a script path to the actual file system path.
 * Handles both /data/scripts/... (stored format) and actual file paths.
 */
const resolveScriptPath = (scriptPath: string): string | null => {
  // Validate script path (security check)
  if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
    logger.error(`🚫 Invalid script path: ${scriptPath}`);
    return null;
  }

  const scriptsDir = getScriptsDirectory();
  const filename = path.basename(scriptPath);
  const resolvedPath = path.join(scriptsDir, filename);

  // Additional security: ensure resolved path is within scripts directory
  const normalizedResolved = path.normalize(resolvedPath);
  const normalizedScriptsDir = path.normalize(scriptsDir);

  if (!normalizedResolved.startsWith(normalizedScriptsDir)) {
    logger.error(`🚫 Script path resolves outside scripts directory: ${scriptPath}`);
    return null;
  }

  return normalizedResolved;
};

/**
 * Script metadata interface for enhanced script display
 */
interface ScriptMetadata {
  path: string;           // Full path like /data/scripts/filename.py
  filename: string;       // Just the filename
  name?: string;          // Human-readable name from mm_meta
  emoji?: string;         // Emoji icon from mm_meta
  language: string;       // Inferred from extension or mm_meta
}

/**
 * Sanitize metadata value to prevent XSS
 * Strips HTML tags and limits length
 */
const sanitizeMetadataValue = (value: string, maxLength: number = 100): string => {
  // Strip HTML tags. A single pass is not enough because a stripped tag can
  // leave a new tag behind (e.g. `<scr<script>ipt>` → `<script>`), so loop
  // until the replacement is a fixed point.
  let stripped = value;
  // Bound the loop so a pathological input can't keep us iterating forever.
  for (let i = 0; i < 10; i++) {
    const next = stripped.replace(/<[^>]*>/g, '');
    if (next === stripped) break;
    stripped = next;
  }
  // Limit length
  return stripped.substring(0, maxLength).trim();
};

/**
 * Parse mm_meta block from script content
 * Format:
 * # mm_meta:
 * #   name: Script Display Name
 * #   emoji: 📡
 * #   language: Python
 */
const parseScriptMetadata = (content: string, _filename: string): Partial<ScriptMetadata> => {
  const metadata: Partial<ScriptMetadata> = {};

  // Look for mm_meta block - supports both # and // comment styles
  const metaMatch = content.match(/^[#/]{1,2}\s*mm_meta:\s*\n((?:[#/]{1,2}\s+\w+:.*\n?)+)/m);

  if (metaMatch) {
    const metaBlock = metaMatch[1];

    // Parse name (sanitize to prevent XSS, max 100 chars)
    const nameMatch = metaBlock.match(/^[#/]{1,2}\s+name:\s*(.+)$/m);
    if (nameMatch) {
      metadata.name = sanitizeMetadataValue(nameMatch[1], 100);
    }

    // Parse emoji (sanitize, limit to 10 chars for emoji sequences)
    const emojiMatch = metaBlock.match(/^[#/]{1,2}\s+emoji:\s*(.+)$/m);
    if (emojiMatch) {
      metadata.emoji = sanitizeMetadataValue(emojiMatch[1], 10);
    }

    // Parse language (sanitize, max 20 chars)
    const langMatch = metaBlock.match(/^[#/]{1,2}\s+language:\s*(.+)$/m);
    if (langMatch) {
      metadata.language = sanitizeMetadataValue(langMatch[1], 20);
    }
  }

  return metadata;
};

/**
 * Get language display name from file extension
 */
const getLanguageFromExtension = (filename: string): string => {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.py': return 'Python';
    case '.js': return 'JavaScript';
    case '.mjs': return 'JavaScript';
    case '.sh': return 'Shell';
    default: return 'Script';
  }
};

// Public endpoint to list available scripts (no CSRF or auth required).
// Exported so server.ts can mount it directly on the app (bypassing the
// apiRouter's CSRF protection) at /api/scripts.
export const scriptsEndpoint = (_req: any, res: any) => {
  try {
    const scriptsDir = getScriptsDirectory();

    // Check if directory exists
    if (!fs.existsSync(scriptsDir)) {
      logger.debug(`📁 Scripts directory does not exist: ${scriptsDir}`);
      return res.json({ scripts: [] });
    }

    // Read directory and filter for valid script extensions
    const files = fs.readdirSync(scriptsDir);
    const validExtensions = ['.js', '.mjs', '.py', '.sh'];

    const scriptFiles = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return validExtensions.includes(ext);
      })
      .sort();

    // Build script metadata for each file
    const scripts: ScriptMetadata[] = scriptFiles.map(file => {
      const filePath = path.join(scriptsDir, file);
      const scriptPath = `/data/scripts/${file}`;

      // Start with defaults
      const script: ScriptMetadata = {
        path: scriptPath,
        filename: file,
        language: getLanguageFromExtension(file),
      };

      // Try to read and parse metadata from file
      try {
        // Only read first 1KB to find metadata block (performance optimization)
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(1024);
        const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
        fs.closeSync(fd);

        const content = buffer.toString('utf8', 0, bytesRead);
        const metadata = parseScriptMetadata(content, file);

        if (metadata.name) script.name = metadata.name;
        if (metadata.emoji) script.emoji = metadata.emoji;
        if (metadata.language) script.language = metadata.language;
      } catch (readError) {
        // Silently ignore read errors - script will just use defaults
        logger.debug(`📜 Could not read metadata from ${file}: ${readError}`);
      }

      return script;
    });

    if (env.isDevelopment && scripts.length > 0) {
      logger.debug(`📜 Found ${scripts.length} script(s) in ${scriptsDir}`);
    }

    res.json({ scripts });
  } catch (error) {
    logger.error('❌ Error listing scripts:', error);
    res.status(500).json({ error: 'Failed to list scripts', scripts: [] });
  }
};

const router: Router = express.Router();

// Script test endpoint - allows testing script execution with sample parameters
// Supports triggerType: 'auto-responder' (default), 'geofence', or 'timer'
router.post('/scripts/test', requirePermission('settings', 'read'), async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const {
      script,
      triggerType = 'auto-responder',
      // Auto-responder specific
      trigger,
      testMessage,
      scriptArgs,
      // Geofence specific
      geofenceName,
      geofenceId,
      eventType,
      nodeLat,
      nodeLon,
      // Timer specific
      timerName,
      timerId,
      // Mock node info (optional)
      mockNode,
      // Protocol discriminator. Defaults to 'meshtastic' for backwards
      // compatibility. When 'meshcore', adds MESHCORE_* env vars so a
      // MeshCore-targeting script can branch on which stack invoked it.
      protocol = 'meshtastic',
      meshcoreSourceId,
      meshcoreDeviceType,
    } = req.body;

    // Validate based on trigger type
    if (triggerType === 'auto-responder') {
      if (!script || !trigger || !testMessage) {
        return res.status(400).json({ error: 'Missing required fields: script, trigger, testMessage' });
      }
    } else if (triggerType === 'geofence') {
      if (!script) {
        return res.status(400).json({ error: 'Missing required field: script' });
      }
    } else if (triggerType === 'timer') {
      if (!script) {
        return res.status(400).json({ error: 'Missing required field: script' });
      }
    } else {
      return res.status(400).json({ error: `Invalid triggerType: ${triggerType}. Expected 'auto-responder', 'geofence', or 'timer'` });
    }

    // Validate script path (security check)
    if (!script.startsWith('/data/scripts/') || script.includes('..')) {
      return res.status(400).json({ error: 'Invalid script path' });
    }

    // Resolve script path
    const resolvedPath = resolveScriptPath(script);
    if (!resolvedPath) {
      return res.status(400).json({ error: 'Failed to resolve script path' });
    }

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Script file not found' });
    }

    let matchedPattern: string | null = null;
    let extractedParams: Record<string, string> = {};

    // Auto-responder: Extract parameters from test message using trigger pattern
    if (triggerType === 'auto-responder') {
      const allPatterns = normalizeTriggerPatterns(trigger);
      // Cap the number of candidate patterns to prevent user input from
      // driving an unbounded match loop.
      const MAX_PATTERNS = 100;
      const patterns = allPatterns.slice(0, MAX_PATTERNS);

      // Try each pattern until one matches
      for (const patternStr of patterns) {
        // ReDoS guard: reject overly long patterns and classic catastrophic-
        // backtracking shapes before compiling. Script-trigger patterns are
        // admin-authored but CodeQL flags the regex compile below as
        // user-controlled, so we enforce the same bounds the UI does.
        if (patternStr.length > 500) {
          return res.status(400).json({ error: 'Trigger pattern too long (max 500 characters).' });
        }
        if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(patternStr)) {
          return res.status(400).json({ error: 'Trigger pattern too complex or may cause performance issues.' });
        }
        interface ParamSpec {
          name: string;
          pattern?: string;
        }
        const params: ParamSpec[] = [];
        let i = 0;

        // Extract parameter specifications
        while (i < patternStr.length) {
          if (patternStr[i] === '{') {
            const startPos = i + 1;
            let depth = 1;
            let colonPos = -1;
            let endPos = -1;

            for (let j = startPos; j < patternStr.length && depth > 0; j++) {
              if (patternStr[j] === '{') {
                depth++;
              } else if (patternStr[j] === '}') {
                depth--;
                if (depth === 0) {
                  endPos = j;
                }
              } else if (patternStr[j] === ':' && depth === 1 && colonPos === -1) {
                colonPos = j;
              }
            }

            if (endPos !== -1) {
              const paramName =
                colonPos !== -1 ? patternStr.substring(startPos, colonPos) : patternStr.substring(startPos, endPos);
              const paramPattern = colonPos !== -1 ? patternStr.substring(colonPos + 1, endPos) : undefined;

              if (!params.find(p => p.name === paramName)) {
                params.push({ name: paramName, pattern: paramPattern });
              }

              i = endPos + 1;
            } else {
              i++;
            }
          } else {
            i++;
          }
        }

        // Build regex pattern
        let regexPattern = '';
        const replacements: Array<{ start: number; end: number; replacement: string }> = [];
        i = 0;

        while (i < patternStr.length) {
          if (patternStr[i] === '{') {
            const startPos = i;
            let depth = 1;
            let endPos = -1;

            for (let j = i + 1; j < patternStr.length && depth > 0; j++) {
              if (patternStr[j] === '{') {
                depth++;
              } else if (patternStr[j] === '}') {
                depth--;
                if (depth === 0) {
                  endPos = j;
                }
              }
            }

            if (endPos !== -1) {
              const paramIndex = replacements.length;
              if (paramIndex < params.length) {
                const paramRegex = params[paramIndex].pattern || '[^\\s]+';
                replacements.push({
                  start: startPos,
                  end: endPos + 1,
                  replacement: `(${paramRegex})`,
                });
              }
              i = endPos + 1;
            } else {
              i++;
            }
          } else {
            i++;
          }
        }

        // Build the final pattern by replacing placeholders
        for (let i = 0; i < patternStr.length; i++) {
          const replacement = replacements.find(r => r.start === i);
          if (replacement) {
            regexPattern += replacement.replacement;
            i = replacement.end - 1;
          } else {
            const char = patternStr[i];
            if (/[.*+?^${}()|[\]\\]/.test(char)) {
              regexPattern += '\\' + char;
            } else {
              regexPattern += char;
            }
          }
        }

        // Length cap on the assembled regex so a pathological combination of
        // param patterns (each up to /[^\s]+/) plus a long pattern string can't
        // produce a multi-kilobyte regex that the engine spends real CPU
        // compiling. Triggers are admin-configured and 100 chars max each, so
        // 2000 chars is generous headroom. Closes CodeQL js/regex-injection #32.
        if (regexPattern.length > 2000) {
          continue;
        }
        const triggerRegex = compileUserRegex(`^${regexPattern}$`, 'i');
        const triggerMatch = testMessage.match(triggerRegex);

        if (triggerMatch) {
          extractedParams = {};
          params.forEach((param, index) => {
            // Guard against prototype-pollution / remote-property-injection:
            // only accept simple identifier-style names, never `__proto__` etc.
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) {
              return;
            }
            Object.defineProperty(extractedParams, param.name, {
              value: triggerMatch[index + 1],
              enumerable: true,
              writable: true,
              configurable: true,
            });
          });
          matchedPattern = patternStr;
          break;
        }
      }

      if (!matchedPattern) {
        return res.status(400).json({ error: `Test message does not match trigger pattern: "${trigger}"` });
      }
    }

    // Determine interpreter based on file extension
    const ext = script.split('.').pop()?.toLowerCase();
    let interpreter: string;

    const useSystemBin = process.env.NODE_ENV !== 'production' || process.env.IS_DESKTOP === 'true';

    switch (ext) {
      case 'js':
      case 'mjs':
        interpreter = useSystemBin ? 'node' : '/usr/local/bin/node';
        break;
      case 'py':
        interpreter = useSystemBin ? 'python3' : '/opt/apprise-venv/bin/python3';
        break;
      case 'sh':
        interpreter = useSystemBin ? 'sh' : '/bin/sh';
        break;
      default:
        return res.status(400).json({ error: `Unsupported script extension: ${ext}` });
    }

    // Execute script
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Prepare base environment variables
    const scriptEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };

    // Default mock node info
    const mockNodeNum = mockNode?.nodeNum?.toString() || '12345';
    const mockShortName = mockNode?.shortName || 'TEST';
    const mockLongName = mockNode?.longName || 'Test Node';
    const mockNodeLat = mockNode?.lat?.toString() || nodeLat?.toString() || '37.7749';
    const mockNodeLon = mockNode?.lon?.toString() || nodeLon?.toString() || '-122.4194';

    // Set environment variables based on trigger type
    if (triggerType === 'auto-responder') {
      scriptEnv.MESSAGE = testMessage;
      scriptEnv.FROM_NODE = mockNodeNum;
      scriptEnv.FROM_SHORT_NAME = mockShortName;
      scriptEnv.FROM_LONG_NAME = mockLongName;
      scriptEnv.PACKET_ID = '99999';
      scriptEnv.TRIGGER = Array.isArray(trigger) ? trigger.join(', ') : trigger;
      // Add extracted parameters as PARAM_* environment variables
      Object.entries(extractedParams).forEach(([key, value]) => {
        scriptEnv[`PARAM_${key}`] = value;
      });
    } else if (triggerType === 'geofence') {
      scriptEnv.GEOFENCE_NAME = geofenceName || 'Test Geofence';
      scriptEnv.GEOFENCE_ID = geofenceId || 'test-geofence-id';
      scriptEnv.GEOFENCE_EVENT = eventType || 'entry';
      scriptEnv.EVENT = eventType || 'entry';
      scriptEnv.NODE_LAT = mockNodeLat;
      scriptEnv.NODE_LON = mockNodeLon;
      scriptEnv.NODE_NUM = mockNodeNum;
      scriptEnv.NODE_ID = mockNodeNum;
      scriptEnv.SHORT_NAME = mockShortName;
      scriptEnv.LONG_NAME = mockLongName;
      scriptEnv.DISTANCE_TO_CENTER = '0.5'; // Test distance in km
    } else if (triggerType === 'timer') {
      scriptEnv.TIMER_NAME = timerName || 'Test Timer';
      scriptEnv.TIMER_ID = timerId || 'test-timer-id';
      scriptEnv.TIMER_SCRIPT = script;
    }

    // Common environment variables for all trigger types
    const meshtasticIp = process.env.MESHTASTIC_NODE_IP || process.env.MESHTASTIC_IP || process.env.NODE_IP || '127.0.0.1';
    const meshtasticPort = process.env.MESHTASTIC_NODE_PORT || process.env.MESHTASTIC_PORT || process.env.NODE_PORT || '4403';
    scriptEnv.IP = meshtasticIp;
    scriptEnv.PORT = meshtasticPort;
    scriptEnv.MESHTASTIC_IP = meshtasticIp;
    scriptEnv.MESHTASTIC_PORT = meshtasticPort;
    scriptEnv.VERSION = process.env.VERSION || 'test';

    // Protocol discriminator. Leaves the MESHTASTIC_* vars in place
    // (harmless for MeshCore scripts) but adds MESHCORE_* so scripts
    // can branch on which stack invoked them.
    if (protocol === 'meshcore') {
      scriptEnv.MESHCORE_SOURCE_ID = String(meshcoreSourceId || 'test-source');
      scriptEnv.MESHCORE_DEVICE_TYPE = String(meshcoreDeviceType || 'companion');
    }

    // Build script arguments if provided
    const scriptArgList: string[] = [resolvedPath];
    if (scriptArgs) {
      // Token expansion for script args (basic expansion for test)
      let expandedArgs = scriptArgs
        .replace(/\{IP\}/g, scriptEnv.IP)
        .replace(/\{PORT\}/g, scriptEnv.PORT)
        .replace(/\{VERSION\}/g, scriptEnv.VERSION)
        .replace(/\{NODE_ID\}/g, mockNodeNum)
        .replace(/\{NODE_NUM\}/g, mockNodeNum)
        .replace(/\{SHORT_NAME\}/g, mockShortName)
        .replace(/\{LONG_NAME\}/g, mockLongName);

      if (triggerType === 'geofence') {
        expandedArgs = expandedArgs
          .replace(/\{GEOFENCE_NAME\}/g, scriptEnv.GEOFENCE_NAME)
          .replace(/\{EVENT\}/g, scriptEnv.GEOFENCE_EVENT)
          .replace(/\{NODE_LAT\}/g, mockNodeLat)
          .replace(/\{NODE_LON\}/g, mockNodeLon);
      }

      // Split args respecting both single and double quotes
      const argParts = expandedArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      scriptArgList.push(...argParts.map((arg: string) => arg.replace(/^["']|["']$/g, '')));
    }

    try {
      const { stdout, stderr } = await execFileAsync(interpreter, scriptArgList, {
        timeout: 30000,
        env: { ...scriptEnv, ...scriptDependencyEnv(ext, scriptEnv) },
        maxBuffer: 1024 * 1024, // 1MB max output
      });

      const executionTimeMs = Date.now() - startTime;
      const output = stdout.trim();
      const errorOutput = stderr.trim();

      // Parse JSON output to extract "would send" messages
      let wouldSendMessages: string[] = [];
      let returnValue: unknown = null;

      if (output) {
        try {
          const parsed = JSON.parse(output);
          returnValue = parsed;
          // Look for response/responses fields that indicate messages to send
          if (parsed.response) {
            wouldSendMessages = Array.isArray(parsed.response) ? parsed.response : [parsed.response];
          } else if (parsed.responses) {
            wouldSendMessages = Array.isArray(parsed.responses) ? parsed.responses : [parsed.responses];
          } else if (typeof parsed === 'string') {
            wouldSendMessages = [parsed];
          }
        } catch {
          // Not JSON - the output itself might be the message
          if (output && output !== '(no output)') {
            wouldSendMessages = [output];
          }
        }
      }

      return res.json({
        success: true,
        stdout: output || '(no output)',
        stderr: errorOutput || undefined,
        wouldSendMessages,
        returnValue,
        extractedParams: triggerType === 'auto-responder' ? extractedParams : undefined,
        matchedPattern: triggerType === 'auto-responder' ? matchedPattern : undefined,
        executionTimeMs,
      });
    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;

      // Handle execution errors
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        return res.status(408).json({
          success: false,
          error: 'Script execution timed out after 30 seconds',
          executionTimeMs,
        });
      }

      // Handle Windows EPERM errors gracefully (process may have already terminated)
      if (error.code === 'EPERM' && process.platform === 'win32') {
        // On Windows, EPERM can occur when trying to kill a process that's already dead
        // If we got stdout/stderr before the error, return that
        if (error.stdout || error.stderr) {
          const output = error.stdout?.toString().trim() || '';
          let wouldSendMessages: string[] = [];
          let returnValue: unknown = null;

          if (output) {
            try {
              const parsed = JSON.parse(output);
              returnValue = parsed;
              if (parsed.response) {
                wouldSendMessages = Array.isArray(parsed.response) ? parsed.response : [parsed.response];
              } else if (parsed.responses) {
                wouldSendMessages = Array.isArray(parsed.responses) ? parsed.responses : [parsed.responses];
              }
            } catch {
              if (output) wouldSendMessages = [output];
            }
          }

          return res.json({
            success: true,
            stdout: output || '(no output)',
            stderr: error.stderr?.toString().trim() || undefined,
            wouldSendMessages,
            returnValue,
            extractedParams: triggerType === 'auto-responder' ? extractedParams : undefined,
            matchedPattern: triggerType === 'auto-responder' ? matchedPattern : undefined,
            executionTimeMs,
          });
        }
        // Otherwise, return a more user-friendly error
        return res.status(500).json({
          success: false,
          error: 'Script execution completed but encountered a cleanup error (this is usually harmless)',
          stderr: error.stderr?.toString() || undefined,
          executionTimeMs,
        });
      }

      return res.status(500).json({
        success: false,
        error: error.message || 'Script execution failed',
        stderr: error.stderr?.toString() || undefined,
        executionTimeMs,
      });
    }
  } catch (error: any) {
    const executionTimeMs = Date.now() - startTime;
    logger.error('❌ Error testing script:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      executionTimeMs,
    });
  }
});

// HTTP trigger test endpoint - allows testing HTTP triggers safely through backend proxy
router.post('/http/test', requirePermission('settings', 'read'), async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Missing required field: url' });
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Security: Only allow HTTP and HTTPS protocols
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are allowed' });
    }

    // Make the HTTP request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await safeFetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/plain, text/*, application/json',
          'User-Agent': 'MeshMonitor/AutoResponder-Test',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return res.status(response.status).json({
          error: `HTTP ${response.status}: ${response.statusText}`,
        });
      }

      const text = await response.text();

      return res.json({
        result: text.substring(0, 500) + (text.length > 500 ? '...' : ''),
        status: response.status,
        statusText: response.statusText,
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError instanceof SsrfBlockedError) {
        logger.warn(`HTTP test blocked by SSRF guard (${fetchError.reason}): ${url}`);
        return res.status(400).json({ error: 'URL target not allowed' });
      }

      if (fetchError.name === 'AbortError') {
        return res.status(408).json({ error: 'Request timed out after 10 seconds' });
      }

      return res.status(500).json({
        error: fetchError.message || 'Failed to fetch URL',
      });
    }
  } catch (error: any) {
    logger.error('❌ Error testing HTTP trigger:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Script import endpoint - upload a script file
router.post(
  '/scripts/import',
  requirePermission('settings', 'write'),
  express.raw({ type: '*/*', limit: '5mb' }),
  async (req: Request, res: Response) => {
    try {
      const filename = req.headers['x-filename'] as string;

      if (!filename) {
        return res.status(400).json({ error: 'Filename header (x-filename) is required' });
      }

      // Security: Validate filename
      const sanitizedFilename = path.basename(filename); // Remove any path components
      const ext = path.extname(sanitizedFilename).toLowerCase();
      const validExtensions = ['.js', '.mjs', '.py', '.sh'];

      if (!validExtensions.includes(ext)) {
        return res.status(400).json({ error: `Invalid file extension. Allowed: ${validExtensions.join(', ')}` });
      }

      const scriptsDir = getScriptsDirectory();
      const resolvedScriptsDir = path.resolve(scriptsDir);
      const filePath = path.resolve(path.join(scriptsDir, sanitizedFilename));

      // Defense in depth: reject any filename that, after resolution, would
      // escape the scripts directory (e.g. symlink tricks or odd basename edge
      // cases). path.basename() already stripped path components above.
      if (!filePath.startsWith(resolvedScriptsDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      // Ensure scripts directory exists
      if (!fs.existsSync(scriptsDir)) {
        fs.mkdirSync(scriptsDir, { recursive: true });
      }

      // Write file
      fs.writeFileSync(filePath, req.body);

      // Set executable permissions (Unix-like systems)
      if (process.platform !== 'win32') {
        fs.chmodSync(filePath, 0o755);
      }

      logger.info(`✅ Script imported: ${sanitizedFilename}`);
      res.json({ success: true, filename: sanitizedFilename, path: `/data/scripts/${sanitizedFilename}` });
    } catch (error: any) {
      logger.error('❌ Error importing script:', error);
      res.status(500).json({ error: error.message || 'Failed to import script' });
    }
  }
);

// Script export endpoint - download selected scripts as zip
router.post('/scripts/export', requirePermission('settings', 'read'), async (req: Request, res: Response) => {
  try {
    const { scripts } = req.body;

    if (!Array.isArray(scripts) || scripts.length === 0) {
      return res.status(400).json({ error: 'Scripts array is required' });
    }

    const scriptsDir = getScriptsDirectory();
    // archiver v8 exposes only named class exports; @types/archiver still ships v7 types.
    const { ZipArchive } = (await import('archiver')) as unknown as {
      ZipArchive: new (opts: import('archiver').ArchiverOptions) => import('archiver').Archiver;
    };
    const archive = new ZipArchive({ zlib: { level: 9 } });

    res.attachment('scripts-export.zip');
    archive.pipe(res);

    for (const scriptPath of scripts) {
      // Validate script path
      if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
        logger.warn(`⚠️  Skipping invalid script path: ${scriptPath}`);
        continue;
      }

      const filename = path.basename(scriptPath);
      const filePath = path.join(scriptsDir, filename);

      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: filename });
      } else {
        logger.warn(`⚠️  Script not found: ${filename}`);
      }
    }

    await archive.finalize();
    logger.debug(`✅ Exported ${scripts.length} script(s) as zip`);
  } catch (error: any) {
    logger.error('❌ Error exporting scripts:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Failed to export scripts' });
    }
  }
});

// Script dependency management (Option A): declare deps via manifests in the
// scripts directory (requirements.txt / package.json) and install them next to
// the scripts. Status is settings:read; installing runs third-party code so it
// requires settings:write.
router.get('/scripts/dependencies', requirePermission('settings', 'read'), async (_req: Request, res: Response) => {
  try {
    res.json(await getDependencyStatus());
  } catch (error) {
    logger.error('[API] Error getting script dependency status:', error);
    res.status(500).json({ error: 'Failed to get script dependency status' });
  }
});

router.post('/scripts/dependencies/install', requirePermission('settings', 'write'), async (_req: Request, res: Response) => {
  try {
    const result = await installDependencies();
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    logger.error('[API] Error installing script dependencies:', error);
    res.status(500).json({ success: false, log: '', error: 'Failed to install script dependencies' });
  }
});

// Script delete endpoint
router.delete('/scripts/:filename', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
  try {
    const filename = req.params.filename;

    // Security: Validate filename
    const sanitizedFilename = path.basename(filename);

    const scriptsDir = getScriptsDirectory();
    const filePath = path.join(scriptsDir, sanitizedFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Script not found' });
    }

    fs.unlinkSync(filePath);
    logger.info(`✅ Script deleted: ${sanitizedFilename}`);
    res.json({ success: true, filename: sanitizedFilename });
  } catch (error: any) {
    logger.error('❌ Error deleting script:', error);
    res.status(500).json({ error: error.message || 'Failed to delete script' });
  }
});

export default router;
