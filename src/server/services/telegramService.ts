import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

interface TelegramSettings {
  enabled: boolean;
  botToken: string;
  chatId: string;
  adminUserIds: Set<number>;
  bridgeChannelIndex: number;
  bridgeSourceId: string;
  forwardMessages: boolean;
  forwardDMs: boolean;
  notifyNewNodes: boolean;
  notifyInactive: boolean;
  prefix: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string };
  chat: { id: number };
  text?: string;
  date: number;
}

const SETTINGS_CACHE_TTL_MS = 60_000;

/**
 * Native Telegram Bot integration for MeshMonitor.
 *
 * Bridges Meshtastic mesh messages ↔ Telegram chat via the Telegram Bot API.
 * Uses long polling — no public URL or webhook setup required.
 *
 * Message flows:
 *   Mesh channel/DM  →  Telegram chat (forwarding)
 *   Telegram chat    →  Mesh channel (admin-controlled)
 *
 * Commands available in Telegram:
 *   /help    - list commands
 *   /status  - show connected sources and node counts
 *   /nodes   - list recently active nodes
 *   /send [channel] <message>  - send to mesh (admins only)
 */
class TelegramService {
  private polling = false;
  private updateOffset = 0;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;

  private settingsCache: TelegramSettings | null = null;
  private settingsCacheTime = 0;

  // Lazily resolved to avoid circular import at module init time
  private getSourceRegistry() {
    return (global as any).sourceManagerRegistry as {
      getAllManagers: () => Array<{
        sourceId: string;
        getStatus: () => { connected: boolean; sourceName?: string; sourceId: string; sourceType: string };
        getLocalNodeInfo: () => { longName: string; shortName: string } | null;
        sendTextMessage: (text: string, channel: number) => Promise<number>;
      }>;
      getManager: (id: string) => {
        sendTextMessage: (text: string, channel: number) => Promise<number>;
      } | undefined;
    } | undefined;
  }

  // ─── Telegram Bot API ────────────────────────────────────────────────────

  private async callApi(token: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as { ok: boolean; result?: any; description?: string };
    if (!data.ok) throw new Error(`Telegram API [${method}]: ${data.description}`);
    return data.result;
  }

  // ─── Settings ────────────────────────────────────────────────────────────

  private async loadSettings(): Promise<TelegramSettings> {
    const now = Date.now();
    if (this.settingsCache && (now - this.settingsCacheTime) < SETTINGS_CACHE_TTL_MS) {
      return this.settingsCache;
    }

    const bool = (v: string | null | undefined, d: boolean) =>
      v != null ? (v === 'true' || v === '1') : d;
    const int = (v: string | null | undefined, d: number) => {
      const n = parseInt(v ?? '', 10);
      return isNaN(n) ? d : n;
    };

    const [
      enabled, botToken, chatId, adminRaw, channelRaw,
      sourceId, fwdMsg, fwdDM, notifyNew, notifyInactive, prefix,
    ] = await Promise.all([
      databaseService.settings.getSetting('telegramEnabled'),
      databaseService.settings.getSetting('telegramBotToken'),
      databaseService.settings.getSetting('telegramChatId'),
      databaseService.settings.getSetting('telegramAdminUserIds'),
      databaseService.settings.getSetting('telegramBridgeChannelIndex'),
      databaseService.settings.getSetting('telegramBridgeSourceId'),
      databaseService.settings.getSetting('telegramForwardMessages'),
      databaseService.settings.getSetting('telegramForwardDMs'),
      databaseService.settings.getSetting('telegramNotifyNewNodes'),
      databaseService.settings.getSetting('telegramNotifyInactive'),
      databaseService.settings.getSetting('telegramPrefix'),
    ]);

    const adminUserIds = new Set<number>(
      (adminRaw ?? '')
        .split(',')
        .map((s: string) => parseInt(s.trim(), 10))
        .filter((n: number) => !isNaN(n))
    );

    this.settingsCache = {
      enabled: bool(enabled, false),
      botToken: botToken ?? '',
      chatId: chatId ?? '',
      adminUserIds,
      bridgeChannelIndex: int(channelRaw, 0),
      bridgeSourceId: sourceId ?? '',
      forwardMessages: bool(fwdMsg, true),
      forwardDMs: bool(fwdDM, false),
      notifyNewNodes: bool(notifyNew, true),
      notifyInactive: bool(notifyInactive, false),
      prefix: prefix ?? '[TG] ',
    };
    this.settingsCacheTime = now;
    return this.settingsCache;
  }

  public invalidateCache(): void {
    this.settingsCache = null;
    this.settingsCacheTime = 0;
  }

  // ─── Polling ─────────────────────────────────────────────────────────────

  public async start(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    logger.info('🤖 [Telegram] Service starting (long polling)');
    this.schedulePoll(0);
  }

  public stop(): void {
    this.polling = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    logger.info('🤖 [Telegram] Service stopped');
  }

  private schedulePoll(delayMs: number): void {
    if (!this.polling) return;
    this.pollingTimer = setTimeout(() => this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const settings = await this.loadSettings();
      if (!settings.enabled || !settings.botToken) {
        this.schedulePoll(30_000);
        return;
      }

      const updates = await this.callApi(settings.botToken, 'getUpdates', {
        offset: this.updateOffset,
        timeout: 25,
        allowed_updates: ['message'],
      }) as TelegramUpdate[];

      for (const update of updates) {
        this.updateOffset = update.update_id + 1;
        if (update.message) {
          await this.handleMessage(update.message, settings).catch(err =>
            logger.error('[Telegram] handleMessage error:', err?.message)
          );
        }
      }

      this.schedulePoll(0);
    } catch (err: any) {
      const delay = String(err?.message).includes('409') ? 60_000 : 5_000;
      logger.warn(`⚠️ [Telegram] Poll error: ${err?.message}. Retry in ${delay / 1000}s`);
      this.schedulePoll(delay);
    }
  }

  // ─── Incoming Telegram → mesh ─────────────────────────────────────────────

  private async handleMessage(msg: TelegramMessage, settings: TelegramSettings): Promise<void> {
    if (!msg.text) return;

    // Restrict to the configured chat (if set)
    if (settings.chatId && String(msg.chat.id) !== settings.chatId) return;

    const text = msg.text.trim();
    const fromId = msg.from?.id ?? 0;
    // Empty admin list = everyone is admin
    const isAdmin = settings.adminUserIds.size === 0 || settings.adminUserIds.has(fromId);

    if (text.startsWith('/')) {
      await this.handleCommand(text, msg, settings, isAdmin);
      return;
    }

    // Plain text from admin → forward to mesh
    if (isAdmin) {
      await this.sendToMesh(`${settings.prefix}${text}`, settings);
    }
  }

  private async handleCommand(
    text: string,
    msg: TelegramMessage,
    settings: TelegramSettings,
    isAdmin: boolean,
  ): Promise<void> {
    // Strip bot @username suffix (e.g. /cmd@MyBot)
    const [rawCmd, ...args] = text.split(' ');
    const cmd = rawCmd.replace(/@\S+$/, '').toLowerCase();

    switch (cmd) {
      case '/help':
        await this.sendText(settings,
          '🌐 *MeshMonitor Telegram Bridge*\n\n' +
          '/help — this message\n' +
          '/status — connection status\n' +
          '/nodes — active nodes (last 24h)\n' +
          (isAdmin ? '/send [ch] <msg> — send to mesh\n' : '') +
          '\nPlain text from admins is forwarded to mesh automatically.',
          msg.chat.id);
        break;

      case '/status':
        await this.sendStatus(settings, msg.chat.id);
        break;

      case '/nodes':
        await this.sendNodeList(settings, msg.chat.id);
        break;

      case '/send':
        if (!isAdmin) {
          await this.sendText(settings, '⛔ Not authorized.', msg.chat.id);
          return;
        }
        await this.handleSendCommand(args, settings, msg.chat.id);
        break;

      default:
        await this.sendText(settings, 'Unknown command. Try /help', msg.chat.id);
    }
  }

  private async handleSendCommand(args: string[], settings: TelegramSettings, chatId: number): Promise<void> {
    if (args.length === 0) {
      await this.sendText(settings, 'Usage: `/send [channel] <message>`', chatId);
      return;
    }

    let channelIndex = settings.bridgeChannelIndex;
    let msgArgs = args;

    if (/^\d+$/.test(args[0])) {
      channelIndex = parseInt(args[0], 10);
      msgArgs = args.slice(1);
    }

    const message = msgArgs.join(' ').trim();
    if (!message) {
      await this.sendText(settings, 'Message cannot be empty.', chatId);
      return;
    }

    await this.sendToMesh(`${settings.prefix}${message}`, settings, channelIndex);
    await this.sendText(settings, `✅ Sent to mesh channel ${channelIndex}`, chatId);
  }

  private async sendToMesh(text: string, settings: TelegramSettings, channelOverride?: number): Promise<void> {
    const channel = channelOverride ?? settings.bridgeChannelIndex;
    const registry = this.getSourceRegistry();
    if (!registry) {
      logger.warn('[Telegram] sourceManagerRegistry not available');
      return;
    }

    const managers = registry.getAllManagers();
    if (managers.length === 0) {
      logger.warn('[Telegram] No source managers available');
      return;
    }

    const manager = settings.bridgeSourceId
      ? registry.getManager(settings.bridgeSourceId)
      : managers[0];

    if (!manager) {
      logger.warn(`[Telegram] Manager not found for source "${settings.bridgeSourceId}"`);
      return;
    }

    try {
      await manager.sendTextMessage(text, channel);
      logger.info(`[Telegram→Mesh] ch${channel}: "${text.substring(0, 80)}"`);
    } catch (err: any) {
      logger.error('[Telegram] sendToMesh failed:', err?.message);
    }
  }

  // ─── Status & nodes commands ──────────────────────────────────────────────

  private async sendStatus(settings: TelegramSettings, chatId: number): Promise<void> {
    try {
      const registry = this.getSourceRegistry();
      const managers = registry?.getAllManagers() ?? [];
      const lines: string[] = ['📡 *MeshMonitor Status*', ''];

      if (managers.length === 0) {
        lines.push('No sources connected');
      } else {
        for (const mgr of managers) {
          const status = mgr.getStatus();
          const nodeInfo = mgr.getLocalNodeInfo();
          const icon = status.connected ? '🟢' : '🔴';
          const name = status.sourceName ?? status.sourceId ?? 'unknown';
          lines.push(
            `${icon} *${name}* (${status.sourceType})` +
            (nodeInfo ? ` — ${nodeInfo.longName} \\(${nodeInfo.shortName}\\)` : '')
          );
        }
      }

      await this.sendText(settings, lines.join('\n'), chatId);
    } catch (err: any) {
      await this.sendText(settings, `❌ ${err?.message}`, chatId);
    }
  }

  private async sendNodeList(settings: TelegramSettings, chatId: number): Promise<void> {
    try {
      const registry = this.getSourceRegistry();
      const managers = registry?.getAllManagers() ?? [];
      const sourceId = settings.bridgeSourceId || managers[0]?.sourceId;

      if (!sourceId) {
        await this.sendText(settings, 'No sources available.', chatId);
        return;
      }

      const nodes = await databaseService.nodes.getAllNodes(sourceId);
      const now = Date.now();
      const recent = nodes
        .filter((n: any) => n.lastHeard && (now - new Date(n.lastHeard).getTime()) < 86_400_000)
        .sort((a: any, b: any) => new Date(b.lastHeard).getTime() - new Date(a.lastHeard).getTime())
        .slice(0, 20);

      if (recent.length === 0) {
        await this.sendText(settings, 'No nodes seen in the last 24h.', chatId);
        return;
      }

      const lines = [`📡 *Active nodes \\(${recent.length}\\)*`, ''];
      for (const node of recent) {
        const name = (node.longName || node.shortName || node.nodeId || 'unknown')
          .replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        const hops = node.hopsAway !== undefined
          ? ` — ${node.hopsAway} hop${node.hopsAway === 1 ? '' : 's'}`
          : '';
        lines.push(`• ${name}${hops}`);
      }

      await this.sendText(settings, lines.join('\n'), chatId);
    } catch (err: any) {
      await this.sendText(settings, `❌ ${err?.message}`, chatId);
    }
  }

  // ─── Outbound helpers ─────────────────────────────────────────────────────

  private async sendText(settings: TelegramSettings, text: string, chatIdOverride?: number): Promise<void> {
    const chatId = chatIdOverride ?? parseInt(settings.chatId, 10);
    if (!chatId || isNaN(chatId) || !settings.botToken) return;
    try {
      await this.callApi(settings.botToken, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
      });
    } catch (err: any) {
      // Fall back to plain text if Markdown parsing fails
      try {
        await this.callApi(settings.botToken, 'sendMessage', { chat_id: chatId, text });
      } catch {
        logger.warn(`[Telegram] sendText failed: ${err?.message}`);
      }
    }
  }

  // ─── Public hooks called by the rest of MeshMonitor ──────────────────────

  /**
   * Forward an inbound mesh message to Telegram.
   * Called by meshtasticManager after a message is stored.
   */
  public async onMeshMessage(params: {
    senderName: string;
    channelName: string;
    text: string;
    isDirectMessage: boolean;
    sourceId: string;
    sourceName: string;
  }): Promise<void> {
    try {
      const settings = await this.loadSettings();
      if (!settings.enabled || !settings.botToken || !settings.chatId) return;
      if (params.isDirectMessage && !settings.forwardDMs) return;
      if (!params.isDirectMessage && !settings.forwardMessages) return;

      const safe = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
      const label = params.isDirectMessage
        ? `📩 *DM* from ${safe(params.senderName)}`
        : `💬 *${safe(params.senderName)}* in ${safe(params.channelName)}`;

      const multiSource = (this.getSourceRegistry()?.getAllManagers().length ?? 0) > 1;
      const sourceTag = multiSource ? ` \\[${safe(params.sourceName)}\\]` : '';

      await this.sendText(settings, `${label}${sourceTag}:\n${safe(params.text)}`);
    } catch (err: any) {
      logger.debug('[Telegram] onMeshMessage error:', err?.message);
    }
  }

  /**
   * Notify Telegram about a newly discovered mesh node.
   * Called by notificationService.notifyNewNode().
   */
  public async onNewNode(params: {
    nodeId: string;
    longName: string;
    shortName: string;
    hopsAway?: number;
    sourceName: string;
  }): Promise<void> {
    try {
      const settings = await this.loadSettings();
      if (!settings.enabled || !settings.botToken || !settings.chatId) return;
      if (!settings.notifyNewNodes) return;

      const safe = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
      const hops = params.hopsAway !== undefined
        ? ` \\(${params.hopsAway} hop${params.hopsAway === 1 ? '' : 's'}\\)`
        : '';
      const multiSource = (this.getSourceRegistry()?.getAllManagers().length ?? 0) > 1;
      const sourceTag = multiSource ? ` \\[${safe(params.sourceName)}\\]` : '';

      await this.sendText(settings,
        `🆕 *New node${sourceTag}*: ${safe(params.longName)} \\(${safe(params.shortName)}\\)${hops}`
      );
    } catch (err: any) {
      logger.debug('[Telegram] onNewNode error:', err?.message);
    }
  }

  /**
   * Notify Telegram when a node goes inactive.
   * Called by inactiveNodeNotificationService.
   */
  public async onNodeInactive(params: {
    longName: string;
    shortName: string;
    inactiveHours: number;
    sourceName: string;
  }): Promise<void> {
    try {
      const settings = await this.loadSettings();
      if (!settings.enabled || !settings.botToken || !settings.chatId) return;
      if (!settings.notifyInactive) return;

      const safe = (s: string) => s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
      const multiSource = (this.getSourceRegistry()?.getAllManagers().length ?? 0) > 1;
      const sourceTag = multiSource ? ` \\[${safe(params.sourceName)}\\]` : '';
      const hoursText = `${params.inactiveHours}h`;

      await this.sendText(settings,
        `😴 *Node inactive${sourceTag}*: ${safe(params.longName)} \\(${safe(params.shortName)}\\) — ${hoursText}`
      );
    } catch (err: any) {
      logger.debug('[Telegram] onNodeInactive error:', err?.message);
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  /**
   * Test the bot token — returns bot username or throws.
   */
  public async testConnection(token: string): Promise<{ ok: true; username: string; firstName: string }> {
    const me = await this.callApi(token, 'getMe');
    return { ok: true, username: me.username ?? '(no username)', firstName: me.first_name ?? '' };
  }

  /**
   * Send a one-off test message to the configured chat.
   */
  public async sendTestMessage(token: string, chatId: string): Promise<void> {
    await this.callApi(token, 'sendMessage', {
      chat_id: parseInt(chatId, 10),
      text: '✅ MeshMonitor Telegram integration is working!',
    });
  }
}

export const telegramService = new TelegramService();
