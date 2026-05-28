/**
 * History handler -- EdgeOne Pages Functions
 * ==========================================
 *
 * File path agents/history/index.ts maps to **POST /history**
 *
 * Reads conversation history from context.store for the given conversation_id
 * (passed via `makers-conversation-id` header by the frontend).
 * Used to restore the chat window after page refresh.
 */

import { createLogger } from '../_logger';

const logger = createLogger('history');

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;

  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if ('content' in obj) return contentToText(obj.content);
    if ('output' in obj) return contentToText(obj.output);
    if ('text' in obj) return String(obj.text ?? '');
    return '';
  }

  if (Array.isArray(content)) {
    return content
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object',
      )
      .map(item => String(item.text ?? item.output_text ?? ''))
      .filter(Boolean)
      .join('\n');
  }

  return String(content);
}

export async function onRequest(context: any) {
  const cid: string = context.conversation_id ?? '';

  const store = context.store ?? null;
  if (!store || !cid) {
    return new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }

  let history: any[] = [];
  try {
    history = await store.getMessages({ conversationId: cid, limit: 100, order: 'asc' });
  } catch (e: unknown) {
    logger.error(`[history] failed to get messages: ${e}`);
    return new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }

  interface FrontendMessage {
    id: string;
    role: string;
    content: string;
    timestamp: number;
  }

  const messages: FrontendMessage[] = [];

  for (const item of history || []) {
    const role = item?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = contentToText(item?.content);
    if (!content) continue;

    messages.push({
      id: item?.message_id ?? item?.messageId ?? `${role}-${item?.created_at ?? item?.createdAt ?? 0}`,
      role,
      content,
      timestamp: item?.created_at ?? item?.createdAt ?? 0,
    });
  }

  return new Response(
    JSON.stringify({ conversation_id: cid, messages }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    },
  );
}
