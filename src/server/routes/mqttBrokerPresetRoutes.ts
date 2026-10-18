/**
 * Saved MQTT broker presets (#5794).
 *
 *   GET    /api/mqtt-broker-presets      { canManage, presets } (see who may read, below)
 *   POST   /api/mqtt-broker-presets      admin: create
 *   PUT    /api/mqtt-broker-presets/:id  admin: replace (a missing `password` keeps the stored one)
 *   DELETE /api/mqtt-broker-presets/:id  admin: delete
 *
 * The table is GLOBAL: one broker is reused by every source. Reading it needs
 * a login and a grant to edit something that takes a broker: `sources:write`
 * or `configuration:write`, on any source. A non-admin gets each preset
 * WITHOUT its username and password, only whether it has them; the server
 * copies them into a config on save (services/mqttBrokerPresetFill.ts).
 *
 * Saving or deleting a preset never touches a source or a radio: a form copies
 * a preset's values in, so what is already saved stays as it is.
 */
import { Router, type Request, type Response } from 'express';
import databaseService from '../../services/database.js';
import { hasPermission, requireAdmin, requireAuth } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import type { MqttBrokerPreset, MqttBrokerPresetInput } from '../../db/repositories/mqttBrokerPresets.js';
import type { User } from '../../types/auth.js';

const router = Router();

export const PRESET_NAME_MAX = 64;
export const PRESET_FIELD_MAX = 255;

/** What a non-admin may see of a preset. */
export interface RedactedMqttBrokerPreset {
  id: number;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  rootTopic: string | null;
  hasUsername: boolean;
  hasPassword: boolean;
}

export function redactPreset(p: MqttBrokerPreset): RedactedMqttBrokerPreset {
  return {
    id: p.id,
    name: p.name,
    host: p.host,
    port: p.port,
    tls: p.tls,
    rootTopic: p.rootTopic,
    hasUsername: !!p.username,
    hasPassword: !!p.password,
  };
}

function fullPreset(p: MqttBrokerPreset): RedactedMqttBrokerPreset & { username: string | null; password: string | null } {
  return { ...redactPreset(p), username: p.username, password: p.password };
}

function optionalString(value: unknown, field: string, max: number): { value: string | null; error?: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { value: null, error: `${field} must be a string` };
  if (value.length > max) return { value: null, error: `${field} must be at most ${max} characters` };
  return { value: value === '' ? null : value };
}

/**
 * Validate a create/replace body. `stored` is the preset being replaced: a
 * `password` left out keeps its password.
 */
export function parsePresetBody(
  body: unknown,
  stored?: MqttBrokerPreset,
): { input?: MqttBrokerPresetInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { error: 'name is required' };
  if (name.length > PRESET_NAME_MAX) return { error: `name must be at most ${PRESET_NAME_MAX} characters` };

  const host = typeof b.host === 'string' ? b.host.trim().toLowerCase() : '';
  if (!host) return { error: 'host is required' };
  if (host.length > PRESET_FIELD_MAX) return { error: `host must be at most ${PRESET_FIELD_MAX} characters` };
  // A bare host name or address: no scheme, port, path, login or spaces.
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return { error: 'host must be a bare host name or IPv4 address, with no scheme, port, path or login' };
  }

  const port = b.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'port must be a whole number from 1 to 65535' };
  }

  if (b.tls !== undefined && typeof b.tls !== 'boolean') return { error: 'tls must be true or false' };
  const tls = b.tls === true;

  const username = optionalString(b.username, 'username', PRESET_FIELD_MAX);
  if (username.error) return { error: username.error };

  let password: string | null;
  if (b.password === undefined && stored) {
    password = stored.password;
  } else {
    const parsed = optionalString(b.password, 'password', PRESET_FIELD_MAX);
    if (parsed.error) return { error: parsed.error };
    password = parsed.value;
  }

  const root = optionalString(typeof b.rootTopic === 'string' ? b.rootTopic.trim() : b.rootTopic, 'rootTopic', PRESET_FIELD_MAX);
  if (root.error) return { error: root.error };
  const rootTopic = root.value === null ? null : root.value.replace(/\/+$/, '');
  if (rootTopic !== null && /[#+\s]/.test(rootTopic)) {
    return { error: 'rootTopic must be a plain topic such as msh/US/FL, with no # or + wildcards or spaces' };
  }

  return {
    input: { name, host, port, tls, username: username.value, password, rootTopic: rootTopic || null },
  };
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Login + a grant to edit something that takes a broker. */
async function canUsePresets(user: User): Promise<boolean> {
  if (user.isAdmin) return true;
  return (
    (await hasPermission(user, 'sources', 'write')) ||
    (await hasPermission(user, 'configuration', 'write'))
  );
}

router.get('/', requireAuth(), async (req: Request, res: Response) => {
  try {
    const user = req.user as User;
    if (!(await canUsePresets(user))) {
      return fail(res, 403, 'FORBIDDEN', 'Saved broker presets need permission to edit sources or device configuration');
    }
    const presets = await databaseService.mqttBrokerPresets.listAsync();
    // `canManage` tells the form whether to offer Save as preset / Manage.
    return ok(res, {
      canManage: user.isAdmin === true,
      presets: user.isAdmin ? presets.map(fullPreset) : presets.map(redactPreset),
    });
  } catch (error) {
    logger.error('Error listing MQTT broker presets:', error);
    return fail(res, 500, 'BROKER_PRESETS_FAILED', 'Failed to list saved broker presets');
  }
});

router.post('/', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const { input, error } = parsePresetBody(req.body);
    if (!input) return fail(res, 400, 'INVALID_INPUT', error ?? 'invalid preset');
    if (await databaseService.mqttBrokerPresets.isNameTakenAsync(input.name)) {
      return fail(res, 409, 'BROKER_PRESET_NAME_TAKEN', `A saved preset is already named "${input.name}"`);
    }
    const preset = await databaseService.mqttBrokerPresets.createAsync(input);
    void databaseService.auditLogAsync(
      req.user!.id,
      'mqtt_broker_preset_created',
      'settings',
      JSON.stringify({ id: preset.id, name: preset.name, host: preset.host, port: preset.port, tls: preset.tls }),
      req.ip || null,
    );
    return ok(res, fullPreset(preset));
  } catch (error) {
    logger.error('Error creating MQTT broker preset:', error);
    return fail(res, 500, 'BROKER_PRESETS_FAILED', 'Failed to save the broker preset');
  }
});

router.put('/:id', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return fail(res, 400, 'INVALID_INPUT', 'id must be a positive integer');
    const stored = await databaseService.mqttBrokerPresets.getAsync(id);
    if (!stored) return fail(res, 404, 'BROKER_PRESET_NOT_FOUND', 'No saved preset has that id');
    const { input, error } = parsePresetBody(req.body, stored);
    if (!input) return fail(res, 400, 'INVALID_INPUT', error ?? 'invalid preset');
    if (await databaseService.mqttBrokerPresets.isNameTakenAsync(input.name, id)) {
      return fail(res, 409, 'BROKER_PRESET_NAME_TAKEN', `A saved preset is already named "${input.name}"`);
    }
    const preset = await databaseService.mqttBrokerPresets.updateAsync(id, input);
    if (!preset) return fail(res, 404, 'BROKER_PRESET_NOT_FOUND', 'No saved preset has that id');
    void databaseService.auditLogAsync(
      req.user!.id,
      'mqtt_broker_preset_updated',
      'settings',
      JSON.stringify({
        id,
        name: preset.name,
        host: preset.host,
        port: preset.port,
        tls: preset.tls,
        passwordChanged: preset.password !== stored.password,
      }),
      req.ip || null,
    );
    return ok(res, fullPreset(preset));
  } catch (error) {
    logger.error('Error updating MQTT broker preset:', error);
    return fail(res, 500, 'BROKER_PRESETS_FAILED', 'Failed to save the broker preset');
  }
});

router.delete('/:id', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return fail(res, 400, 'INVALID_INPUT', 'id must be a positive integer');
    const stored = await databaseService.mqttBrokerPresets.getAsync(id);
    if (!stored || !(await databaseService.mqttBrokerPresets.deleteAsync(id))) {
      return fail(res, 404, 'BROKER_PRESET_NOT_FOUND', 'No saved preset has that id');
    }
    void databaseService.auditLogAsync(
      req.user!.id,
      'mqtt_broker_preset_deleted',
      'settings',
      JSON.stringify({ id, name: stored.name }),
      req.ip || null,
    );
    return ok(res);
  } catch (error) {
    logger.error('Error deleting MQTT broker preset:', error);
    return fail(res, 500, 'BROKER_PRESETS_FAILED', 'Failed to delete the broker preset');
  }
});

export default router;
