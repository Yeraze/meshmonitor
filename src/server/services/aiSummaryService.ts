/**
 * AI channel summaries (#6566).
 *
 * Reads one or more channels' messages over a time window, builds a plain
 * transcript, and asks an OpenAI-compatible chat endpoint (OpenAI, Ollama,
 * LM Studio, vLLM, ...) to summarize it. The Automation Engine's
 * `action.aiSummarize` step calls {@link summarizeChannels}; a later step
 * (usually Notify) sends the result.
 *
 * Sends nothing over the mesh. It does send message text to the configured
 * endpoint, so the endpoint settings are admin-only.
 */
import databaseService from '../../services/database.js';
import { buildServiceEndpoint } from './translation/providers/translateUtils.js';
import { assertSafeUrl } from '../utils/ssrfGuard.js';
import { logger } from '../../utils/logger.js';

/** Settings keys (all admin-only; the `_token` suffix hides the key from non-admins). */
export const AI_SUMMARY_SETTING_KEYS = {
  baseUrl: 'aiSummaryBaseUrl',
  model: 'aiSummaryModel',
  apiKey: 'ai_summary_api_token',
} as const;

export const AI_SUMMARY_DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
export const AI_SUMMARY_DEFAULT_MODEL = 'gpt-4o-mini';
/** Rows read per channel. A guard on memory, not a policy limit. */
export const AI_SUMMARY_FETCH_LIMIT = 5000;
/** Default transcript budget, in characters (~25k tokens). Oldest lines drop first. */
export const AI_SUMMARY_DEFAULT_MAX_INPUT_CHARS = 100_000;
/** Local models can be slow on a long transcript. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Same SSRF stance as the translation backends: loopback allowed for a local LLM. */
const SSRF_OPTS = { strict: false, allowLoopback: true } as const;

export const AI_SUMMARY_DEFAULT_PROMPT =
  'You summarize chat from LoRa mesh radio channels for people who were not reading them. ' +
  'Give the main topics, any questions left unanswered, plans or events mentioned, and anything urgent. ' +
  'Name people by the sender names shown. Be brief and factual, and do not invent details.';

export interface SummaryTarget {
  sourceId: string;
  protocol: 'meshtastic' | 'meshcore';
  /** Local channel slot / index on this source. */
  channel: number;
  channelName: string;
  sourceName?: string;
}

export interface SummarizeRequest {
  targets: SummaryTarget[];
  /** Epoch ms; messages that arrived at or after this are read. */
  sinceMs: number;
  /** Drop Meshtastic messages carrying the is_automation bit (#6449). */
  excludeAutomated: boolean;
  /** Below this many messages the endpoint is not called. */
  minMessages: number;
  /** Extra instructions appended to the default prompt. */
  prompt?: string;
  /** Asked-for maximum summary length in characters (a request to the model, not a cut). */
  maxLength?: number;
  maxInputChars?: number;
}

export interface SummarizeResult {
  messageCount: number;
  /** True when there were fewer than minMessages messages; no request was made. */
  skipped?: boolean;
  summary?: string;
  /** Oldest messages left out to fit maxInputChars. */
  droppedForLength?: number;
  model?: string;
}

export interface TranscriptLine {
  /** Epoch ms. */
  at: number;
  sender: string;
  channel: string;
  text: string;
}

/**
 * Join lines into a transcript, newest kept first when it would pass
 * `maxChars`. Returned text is oldest first.
 */
export function buildTranscript(lines: TranscriptLine[], maxChars: number): { text: string; used: number; dropped: number } {
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  const out: string[] = [];
  let size = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const l = sorted[i];
    const line = `[${new Date(l.at).toISOString().slice(0, 16).replace('T', ' ')}Z] ${l.sender} (${l.channel}): ${l.text.replace(/\s+/g, ' ').trim()}`;
    if (size + line.length + 1 > maxChars && out.length > 0) break;
    out.push(line);
    size += line.length + 1;
  }
  out.reverse();
  return { text: out.join('\n'), used: out.length, dropped: sorted.length - out.length };
}

/** The system prompt sent with every request. */
export function buildSystemPrompt(extra?: string, maxLength?: number): string {
  const parts = [AI_SUMMARY_DEFAULT_PROMPT];
  if (maxLength && maxLength > 0) parts.push(`Keep the summary under ${Math.floor(maxLength)} characters.`);
  if (extra && extra.trim()) parts.push(extra.trim());
  parts.push('Reply with the summary text only.');
  return parts.join('\n\n');
}

async function readSettings(): Promise<{ endpoint: string; model: string; apiKey: string }> {
  const get = async (k: string) => ((await databaseService.settings.getSetting(k)) || '').trim();
  const endpoint = buildServiceEndpoint(
    await get(AI_SUMMARY_SETTING_KEYS.baseUrl),
    AI_SUMMARY_DEFAULT_ENDPOINT,
    '/v1/chat/completions',
    '/chat/completions',
  );
  return {
    endpoint,
    model: (await get(AI_SUMMARY_SETTING_KEYS.model)) || AI_SUMMARY_DEFAULT_MODEL,
    apiKey: await get(AI_SUMMARY_SETTING_KEYS.apiKey),
  };
}

/** One chat-completions request. Throws with a short reason; never echoes the upstream body. */
export async function requestSummary(transcript: string, systemPrompt: string): Promise<{ summary: string; model: string }> {
  const { endpoint, model, apiKey } = await readSettings();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  await assertSafeUrl(endpoint, SSRF_OPTS);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (body) logger.debug(`[AiSummary] endpoint error body (${response.status}): ${body}`);
    throw new Error(`AI endpoint error (${response.status}): ${response.statusText || 'request failed'}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI endpoint returned no summary');
  }
  return { summary: content.trim(), model };
}

/** Read each target channel's messages as transcript lines. */
async function readLines(a: SummarizeRequest): Promise<TranscriptLine[]> {
  const lines: TranscriptLine[] = [];
  for (const t of a.targets) {
    const label = t.sourceName ? `${t.channelName} @ ${t.sourceName}` : t.channelName;
    if (t.protocol === 'meshcore') {
      const rows = await databaseService.meshcore.getChannelMessagesSince(t.channel, t.sourceId, a.sinceMs, AI_SUMMARY_FETCH_LIMIT);
      for (const r of rows) {
        // Received channel rows hold "Name: body"; fromName is the parsed name.
        let text = String(r.text ?? '');
        const name = r.fromName?.trim();
        if (name && text.startsWith(`${name}: `)) text = text.slice(name.length + 2);
        lines.push({ at: Number(r.createdAt), sender: name || 'unknown', channel: label, text });
      }
    } else {
      const rows = await databaseService.messages.getChannelTextSince(t.sourceId, t.channel, a.sinceMs, AI_SUMMARY_FETCH_LIMIT);
      const kept = a.excludeAutomated ? rows.filter((r) => !r.isAutomation) : rows;
      const names = await databaseService.nodes.getNodeNamesByNums(
        [...new Set(kept.map((r) => Number(r.fromNodeNum)))],
        [t.sourceId],
      );
      for (const r of kept) {
        const n = names.get(Number(r.fromNodeNum));
        lines.push({
          at: Number(r.createdAt),
          sender: n?.longName || n?.shortName || r.fromNodeId,
          channel: label,
          text: String(r.text ?? ''),
        });
      }
    }
  }
  return lines.filter((l) => l.text.trim().length > 0);
}

export async function summarizeChannels(a: SummarizeRequest): Promise<SummarizeResult> {
  const lines = await readLines(a);
  if (lines.length === 0 || lines.length < a.minMessages) {
    return { messageCount: lines.length, skipped: true };
  }
  const { text, used, dropped } = buildTranscript(lines, a.maxInputChars ?? AI_SUMMARY_DEFAULT_MAX_INPUT_CHARS);
  const { summary, model } = await requestSummary(text, buildSystemPrompt(a.prompt, a.maxLength));
  return { messageCount: used, summary, model, ...(dropped > 0 ? { droppedForLength: dropped } : {}) };
}
