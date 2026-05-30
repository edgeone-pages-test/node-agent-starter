/**
 * Chat handler -- EdgeOne Makers
 *
 * File path agents/chat/index.ts maps to POST /chat.
 * It streams OpenAI-compatible chat/completions responses, executes EdgeOne
 * sandbox tools when requested, and stores conversation history.
 */

import { getModelConfig } from '../_model';
import { createLogger } from '../_logger';
import { ChatSession } from '../_session';
import { buildTools } from '../_tools';

const logger = createLogger('chat');
const encoder = new TextEncoder();
const MAX_TOOL_ROUNDS = 10;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const SYSTEM_PROMPT = [
  'You are a helpful assistant running inside an EdgeOne sandbox environment.',
  'You have access to these EdgeOne platform tools:',
  '- commands: execute shell commands in the sandbox (e.g. date, ls, uname, curl).',
  '  Parameters: cmd (required, the command to execute), cwd (optional, working directory).',
  '- files: file operations in the sandbox — read, write, list, exists, remove, makeDir.',
  '  Parameters: op (required), path (required for most ops), content (for write).',
  '- code_interpreter: run code in an isolated interpreter.',
  '  Parameters: language (e.g. python, javascript, bash), code (source code to execute).',
  '- browser: interact with web pages — fetch, screenshot, click, type, evaluate.',
  '  Parameters: op (required), url (for fetch), selector, text, script.',
  '',
  "Use tools whenever they help answer the user's question concretely.",
  'Call tools ONE AT A TIME. Do NOT simulate or fake tool outputs — actually call the tool.',
  'Do NOT use any tools other than those listed above.',
].join('\n');

type ChatMessage = Record<string, any>;
type ToolRegistry = ReturnType<typeof buildTools>;
type TraceSpan = {
  setAttributes?: (attributes: Record<string, unknown>) => void;
  end?: () => void;
};

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

interface StreamChunk {
  contentDelta?: string;
  toolCalls?: ToolCallAcc[];
  usage?: Usage;
}

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: Record<string, unknown>,
) {
  controller.enqueue(encoder.encode(sseFrame(event, data)));
}

function sseResponse(event: string, data: Record<string, unknown>, includeDone = false): Response {
  const body = sseFrame(event, data) + (includeDone ? sseFrame('done', {}) : '');
  return new Response(encoder.encode(body), { status: 200, headers: SSE_HEADERS });
}

function redactBase64Image(text: string): string {
  return text.replace(/"base64Image"\s*:\s*"[A-Za-z0-9+/=]{100,}"/g, '"base64Image":"[REDACTED image data]"');
}

function safeJsonPreview(value: unknown, maxLength = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const redacted = redactBase64Image(text);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...<truncated>` : redacted;
}

function buildPayload(model: string, messages: ChatMessage[], toolRegistry: ToolRegistry): ChatMessage {
  const payload: ChatMessage = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (toolRegistry.hasTools()) {
    payload.tools = toolRegistry.tools;
    payload.tool_choice = 'auto';
  }

  return payload;
}

function assistantToolMessage(content: string, toolCalls: ToolCallAcc[]): ChatMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    })),
  };
}

async function loadHistoryAndSaveUser(context: any, session: ChatSession, cid: string, message: string) {
  const span: TraceSpan | undefined = context.tracer?.startSpan?.('session.load_and_save', {
    'session.conversation_id': cid,
  });

  try {
    const [history] = await Promise.all([
      session.getHistory(cid),
      session.saveUserMessage(cid, message),
    ]);
    span?.setAttributes?.({ 'session.history_count': history.length });
    return history;
  } finally {
    span?.end?.();
  }
}

function createToolRegistry(context: any): ToolRegistry {
  const span: TraceSpan | undefined = context.tracer?.startSpan?.('tools.build');

  try {
    const registry = buildTools(context, logger);
    span?.setAttributes?.({
      'tools.count': registry.tools.length,
      'tools.has_tools': registry.hasTools(),
    });
    return registry;
  } finally {
    span?.end?.();
  }
}

async function* parseStreamWithTools(response: Response, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCallAcc>();
  let buffer = '';
  let finishReason = '';
  let usage: Usage | undefined;

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let streamDone = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') {
          streamDone = true;
          break;
        }
        if (!trimmed.startsWith('data: ')) continue;

        const chunk = parseSseJson(trimmed.slice(6));
        if (chunk?.usage) usage = chunk.usage;

        const choice = chunk?.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};
        if (delta.content) {
          yield { contentDelta: delta.content };
        }
        collectToolCallDeltas(toolCalls, delta.tool_calls);
      }

      if (streamDone) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (toolCalls.size > 0 && finishReason === 'tool_calls') {
    yield { toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc), usage };
  } else if (usage) {
    yield { usage };
  }
}

function parseSseJson(json: string): any | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function collectToolCallDeltas(toolCalls: Map<number, ToolCallAcc>, deltas: any[] | undefined) {
  if (!deltas) return;

  for (const delta of deltas) {
    const index = delta?.index ?? 0;
    const toolCall = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };

    if (delta?.id) toolCall.id = delta.id;
    if (delta?.function?.name) toolCall.name = delta.function.name;
    if (delta?.function?.arguments) toolCall.arguments += delta.function.arguments;

    toolCalls.set(index, toolCall);
  }
}

async function streamModelRound(params: {
  context: any;
  url: string;
  model: string;
  apiKey: string;
  payload: ChatMessage;
  round: number;
  signal?: AbortSignal;
  controller: ReadableStreamDefaultController<Uint8Array>;
  onTextDelta: (delta: string) => void;
}): Promise<{ content: string; toolCalls: ToolCallAcc[] | null; stopped: boolean; failed: boolean }> {
  const { context, url, model, apiKey, payload, round, signal, controller, onTextDelta } = params;
  const span: TraceSpan | undefined = context.tracer?.startSpan?.(`llm.request.round_${round}`, {
    'openinference.span.kind': 'LLM',
    'llm.model_name': model,
    'llm.provider': 'openai',
    'llm.request.type': 'chat',
    'llm.request.message_count': payload.messages.length,
    'llm.request.tools_included': 'tools' in payload,
    'llm.request.round': round,
  });

  let content = '';
  let toolCalls: ToolCallAcc[] | null = null;
  let stopped = false;
  let failed = false;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      logger.error(`[handler] LLM API error: ${response.status} ${errorBody}`);
      span?.setAttributes?.({ 'http.status_code': response.status, 'llm.error': true });
      sendEvent(controller, 'error', { message: `LLM API error: ${response.status}` });
      return { content, toolCalls, stopped, failed: true };
    }

    span?.setAttributes?.({ 'http.status_code': 200 });

    for await (const chunk of parseStreamWithTools(response, signal)) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }

      if (chunk.contentDelta) {
        content += chunk.contentDelta;
        onTextDelta(chunk.contentDelta);
      }
      if (chunk.toolCalls) {
        toolCalls = chunk.toolCalls;
      }
      if (chunk.usage) {
        span?.setAttributes?.({
          'llm.token_count.prompt': chunk.usage.prompt_tokens,
          'llm.token_count.completion': chunk.usage.completion_tokens,
          'llm.token_count.total': chunk.usage.total_tokens,
        });
      }
    }
  } finally {
    span?.setAttributes?.({
      'llm.response.content_length': content.length,
      'llm.response.has_tool_calls': !!toolCalls,
    });
    span?.end?.();
  }

  return { content, toolCalls, stopped, failed };
}

function emitToolCallEvents(
  controller: ReadableStreamDefaultController<Uint8Array>,
  toolCalls: ToolCallAcc[],
) {
  for (const tc of toolCalls) {
    sendEvent(controller, 'tool_called', { tool: tc.name });
    sendEvent(controller, 'tool_debug', {
      phase: 'call',
      tool: tc.name,
      id: tc.id,
      argumentsPreview: safeJsonPreview(tc.arguments),
    });
  }
}

async function executeToolCalls(params: {
  context: any;
  toolRegistry: ToolRegistry;
  toolCalls: ToolCallAcc[];
  controller: ReadableStreamDefaultController<Uint8Array>;
}): Promise<string[]> {
  const { context, toolRegistry, toolCalls, controller } = params;
  const spans = toolCalls.map(tc => context.tracer?.startSpan?.(`tool.${tc.name}`, {
    'tool.name': tc.name,
    'tool.call_id': tc.id,
    'tool.arguments_length': tc.arguments.length,
  }));

  try {
    return await Promise.all(toolCalls.map(async (tc, index) => {
      const startedAt = Date.now();
      const result = await toolRegistry.execute(tc.name, tc.arguments);
      const durationMs = Date.now() - startedAt;
      const resultPreview = safeJsonPreview(result, 2000);
      const isError = result.includes('"error"');

      spans[index]?.setAttributes?.({ 'tool.result_length': result.length });
      sendEvent(controller, 'tool_debug', {
        phase: 'result',
        tool: tc.name,
        id: tc.id,
        resultPreview,
        resultLength: result.length,
        durationMs,
        ...(isError ? { error: resultPreview } : {}),
      });

      return result;
    }));
  } finally {
    for (const span of spans) {
      span?.end?.();
    }
  }
}

function appendToolResults(messages: ChatMessage[], toolCalls: ToolCallAcc[], results: string[]) {
  for (let i = 0; i < toolCalls.length; i++) {
    logger.log(`[tool] ${toolCalls[i].name}: ${results[i].slice(0, 200)}`);
    messages.push({
      role: 'tool',
      tool_call_id: toolCalls[i].id,
      content: results[i],
    });
  }
}

export async function onRequest(context: any) {
  const cid: string = context.conversation_id ?? '';
  const rawMessage = context.request.body?.message;

  logger.log(`[handler] conversation_id: ${cid}`);
  context.tracer?.setAttributes?.({
    'agent.scenario': 'node_starter_chat',
    'chat.conversation_id': cid,
    'chat.has_message': !!rawMessage,
  });

  if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
    return sseResponse('error', { message: 'message is required' }, true);
  }

  const message = rawMessage.slice(0, 10000);
  const signal: AbortSignal | undefined = context.request.signal;
  const session = new ChatSession(context.store);
  const history = await loadHistoryAndSaveUser(context, session, cid, message);
  const toolRegistry = createToolRegistry(context);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message },
  ];

  const modelConfig = getModelConfig(context.env ?? {});
  const url = `${modelConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;
  logger.log(`[handler] streaming from: ${url}, model: ${modelConfig.model}, tools: ${toolRegistry.hasTools()}`);

  let assistantContent = '';
  let stopped = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!modelConfig.apiKey || !modelConfig.baseUrl) {
        sendEvent(controller, 'error', {
          message: 'AI Gateway not configured. Set AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL.',
        });
        controller.close();
        return;
      }

      try {
        for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
          if (signal?.aborted) {
            stopped = true;
            break;
          }

          const payload = buildPayload(modelConfig.model, messages, toolRegistry);
          logger.log(`[handler] round ${round}, messages: ${messages.length}`);

          const result = await streamModelRound({
            context,
            url,
            model: modelConfig.model,
            apiKey: modelConfig.apiKey,
            payload,
            round,
            signal,
            controller,
            onTextDelta(delta) {
              assistantContent += delta;
              sendEvent(controller, 'text_delta', { delta });
            },
          });

          stopped = result.stopped;
          if (stopped || result.failed) break;
          if (!result.toolCalls?.length) break;

          messages.push(assistantToolMessage(result.content, result.toolCalls));
          emitToolCallEvents(controller, result.toolCalls);

          const toolResults = await executeToolCalls({
            context,
            toolRegistry,
            toolCalls: result.toolCalls,
            controller,
          });
          appendToolResults(messages, result.toolCalls, toolResults);
        }
      } catch (e: unknown) {
        const error = e as Error;
        if (error.name === 'AbortError' || signal?.aborted) {
          stopped = true;
          logger.log('[stream] aborted by user');
        } else {
          logger.error('[stream] error:', error.message, error.stack);
          context.tracer?.setAttributes?.({
            'error.type': error.name || 'Error',
            'error.message': error.message || String(e),
          });
          sendEvent(controller, 'error', { message: String(error.message ?? e) });
        }
      } finally {
        if (assistantContent) {
          const span: TraceSpan | undefined = context.tracer?.startSpan?.('session.save_assistant_message', {
            'session.conversation_id': cid,
            'session.content_length': assistantContent.length,
          });
          try {
            await session.saveAssistantMessage(cid, assistantContent);
          } finally {
            span?.end?.();
          }
        }

        sendEvent(controller, 'done', { stopped });
        controller.close();
      }
    },
    cancel() {
      logger.log('[stream] client disconnected');
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
