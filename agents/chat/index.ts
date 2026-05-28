/**
 * Chat handler -- EdgeOne Makers
 * ========================================
 *
 * File path agents/chat/index.ts maps to **POST /chat**
 *
 * Uses raw fetch streaming to call the LLM API (OpenAI-compatible chat/completions).
 * Supports tool calling with EdgeOne platform tools (commands, files, code_interpreter, browser).
 *
 * Tool calling flow:
 *   1. Send messages + tools to LLM
 *   2. LLM returns tool_calls -> execute via EdgeOne sandbox
 *   3. Send tool results back to LLM
 *   4. Repeat until LLM gives final text response
 *
 * context convention:
 *   context.request.body    -- object, request body
 *   context.request.signal  -- AbortSignal, set when /chat/stop is called
 *   context.conversation_id -- conversation ID
 *   context.run_id          -- current run ID
 *   context.tracer          -- manual instrumentation API
 */

import { getModelConfig } from '../_model';
import { createLogger } from '../_logger';
import { ChatSession } from '../_session';
import { buildTools } from '../_tools';

const logger = createLogger('chat');

const SYSTEM_PROMPT =
  'You are a helpful assistant running inside an EdgeOne sandbox environment.\n' +
  'You have access to these EdgeOne platform tools:\n' +
  '- commands: execute shell commands in the sandbox (e.g. date, ls, uname, curl).\n' +
  '  Parameters: cmd (required, the command to execute), cwd (optional, working directory).\n' +
  '- files: file operations in the sandbox — read, write, list, exists, remove, makeDir.\n' +
  '  Parameters: op (required), path (required for most ops), content (for write).\n' +
  '- code_interpreter: run code in an isolated interpreter.\n' +
  '  Parameters: language (e.g. python, javascript, bash), code (source code to execute).\n' +
  '- browser: interact with web pages — fetch, screenshot, click, type, evaluate.\n' +
  '  Parameters: op (required), url (for fetch), selector, text, script.\n\n' +
  'Use tools whenever they help answer the user\'s question concretely.\n' +
  'Call tools ONE AT A TIME. Do NOT simulate or fake tool outputs — actually call the tool.\n' +
  'Do NOT use any tools other than those listed above.';

// Maximum number of tool call rounds to prevent infinite loops
const MAX_TOOL_ROUNDS = 10;

const encoder = new TextEncoder();

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Redact base64 image data to prevent flooding the trace panel */
function redactBase64Image(text: string): string {
  return text.replace(/"base64Image"\s*:\s*"[A-Za-z0-9+/=]{100,}"/g, '"base64Image":"[REDACTED image data]"');
}

/** Truncate and redact sensitive content for safe preview in trace events */
function safeJsonPreview(value: unknown, maxLength = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const redacted = redactBase64Image(text || '');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...<truncated>` : redacted;
}

// ========== SSE Stream Parser ==========

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Parse SSE stream from OpenAI-compatible API, handling both content and tool_calls.
 * Tool calls are accumulated across streaming chunks because the API sends
 * arguments incrementally across multiple chunks.
 */
async function* parseStreamWithTools(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<{ contentDelta: string; toolCalls: ToolCallAcc[] | null }> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallsAcc: Map<number, ToolCallAcc> = new Map();
  let finishReason = '';

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let streamDone = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') { streamDone = true; break; }
        if (!trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6);
        let chunk: any;
        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        const choices = chunk?.choices;
        if (!choices?.length) continue;

        const choice = choices[0];
        const delta = choice?.delta || {};
        const choiceFinish = choice?.finish_reason;
        if (choiceFinish) finishReason = choiceFinish;

        // Handle text content
        const content = delta?.content;
        if (content) {
          yield { contentDelta: content, toolCalls: null };
        }

        // Handle tool calls (accumulated across chunks)
        const deltaToolCalls = delta?.tool_calls;
        if (deltaToolCalls) {
          for (const tcDelta of deltaToolCalls) {
            const idx = tcDelta?.index ?? 0;

            if (!toolCallsAcc.has(idx)) {
              toolCallsAcc.set(idx, { id: '', name: '', arguments: '' });
            }

            const tc = toolCallsAcc.get(idx)!;

            if (tcDelta?.id) tc.id = tcDelta.id;

            const func = tcDelta?.function;
            if (func?.name) tc.name = func.name;
            if (func?.arguments) tc.arguments += func.arguments;
          }
        }
      }
      if (streamDone) break;
    }
  } finally {
    reader.releaseLock();
  }

  // After stream ends, yield accumulated tool_calls if any
  if (toolCallsAcc.size > 0 && finishReason === 'tool_calls') {
    const sorted = [...toolCallsAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
    yield { contentDelta: '', toolCalls: sorted };
  }
}

// ========== Core Handler ==========

export async function onRequest(context: any) {
  const cid: string = context.conversation_id ?? '';
  logger.log(`[handler] conversation_id: ${cid}`);

  const body = context.request.body ?? {};
  const rawMessage = body?.message;

  // Tracer: set request-level attributes
  context.tracer?.setAttributes?.({
    'agent.scenario': 'node_starter_chat',
    'chat.conversation_id': cid,
    'chat.has_message': !!rawMessage,
  });

  if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
    return new Response(
      encoder.encode(sseFrame('error', { message: 'message is required' }) + sseFrame('done', {})),
      { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    );
  }
  const message = rawMessage.slice(0, 10000);

  // Get platform cancel signal
  const signal: AbortSignal | undefined = context.request.signal;

  // Session: load history + save user message
  const session = new ChatSession(context.store);

  const sessionSpan = context.tracer?.startSpan?.('session.load_and_save', {
    'session.conversation_id': cid,
  });
  let history: Array<{ role: string; content: string }> = [];
  try {
    const [hist] = await Promise.all([
      session.getHistory(cid),
      session.saveUserMessage(cid, message),
    ]);
    history = hist;
    sessionSpan?.setAttributes?.({ 'session.history_count': history.length });
  } finally {
    sessionSpan?.end?.();
  }

  // Tools: build registry from EdgeOne platform tools
  const toolsSpan = context.tracer?.startSpan?.('tools.build');
  let toolRegistry: ReturnType<typeof buildTools>;
  try {
    toolRegistry = buildTools(context, logger);
    toolsSpan?.setAttributes?.({
      'tools.count': toolRegistry.tools.length,
      'tools.has_tools': toolRegistry.hasTools(),
    });
  } finally {
    toolsSpan?.end?.();
  }

  // Build messages: system + history + user
  const messages: Array<Record<string, any>> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message },
  ];

  const modelConfig = getModelConfig(context.env ?? {});
  const url = `${modelConfig.baseUrl.replace(/\/$/, '')}/chat/completions`;

  logger.log(`[handler] streaming from: ${url}, model: ${modelConfig.model}, tools: ${toolRegistry.hasTools()}`);

  let assistantContent = '';
  let stopped = false;

  const stream = new ReadableStream({
    async start(controller) {
      if (!modelConfig.apiKey || !modelConfig.baseUrl) {
        controller.enqueue(encoder.encode(
          sseFrame('error', { message: 'AI Gateway not configured. Set AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL.' }),
        ));
        controller.close();
        return;
      }

      try {
        for (let roundIdx = 0; roundIdx < MAX_TOOL_ROUNDS; roundIdx++) {
          if (signal?.aborted) {
            stopped = true;
            break;
          }

          // Build payload
          const payload: Record<string, any> = {
            model: modelConfig.model,
            messages,
            stream: true,
          };
          if (toolRegistry.hasTools()) {
            payload.tools = toolRegistry.tools;
            payload.tool_choice = 'auto';
          }

          logger.log(`[handler] round ${roundIdx + 1}, messages: ${messages.length}`);
          logger.log(`[debug] payload.messages: ${JSON.stringify(messages, null, 2)}`);

          // Tracer: LLM request span
          const llmSpan = context.tracer?.startSpan?.(`llm.request.round_${roundIdx + 1}`, {
            'llm.model': modelConfig.model,
            'llm.request.message_count': messages.length,
            'llm.request.tools_included': 'tools' in payload,
            'llm.request.round': roundIdx + 1,
          });

          let roundContent = '';
          let toolCalls: ToolCallAcc[] | null = null;

          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${modelConfig.apiKey}`,
              },
              body: JSON.stringify(payload),
              signal,
            });

            if (!response.ok) {
              const errorBody = await response.text().catch(() => '');
              logger.error(`[handler] LLM API error: ${response.status} ${errorBody}`);
              llmSpan?.setAttributes?.({ 'http.status_code': response.status, 'llm.error': true });
              controller.enqueue(encoder.encode(
                sseFrame('error', { message: `LLM API error: ${response.status}` }),
              ));
              break;
            }

            llmSpan?.setAttributes?.({ 'http.status_code': 200 });

            // Parse streaming response
            for await (const chunk of parseStreamWithTools(response, signal)) {
              if (signal?.aborted) {
                stopped = true;
                break;
              }

              if (chunk.contentDelta) {
                roundContent += chunk.contentDelta;
                assistantContent += chunk.contentDelta;
                controller.enqueue(encoder.encode(
                  sseFrame('text_delta', { delta: chunk.contentDelta }),
                ));
              }

              if (chunk.toolCalls !== null) {
                toolCalls = chunk.toolCalls;
              }
            }
          } finally {
            llmSpan?.setAttributes?.({
              'llm.response.content_length': roundContent.length,
              'llm.response.has_tool_calls': !!toolCalls,
            });
            llmSpan?.end?.();
          }

          if (stopped) break;

          // No tool calls -> done
          if (!toolCalls || toolCalls.length === 0) break;

          logger.log(`[debug] toolCalls raw: ${JSON.stringify(toolCalls, null, 2)}`);

          // Append assistant message with tool_calls
          const assistantMsg: Record<string, any> = { role: 'assistant' };
          assistantMsg.content = roundContent || '';
          assistantMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
          messages.push(assistantMsg);

          logger.log(`[debug] assistantMsg: ${JSON.stringify(assistantMsg, null, 2)}`);

          // Emit tool_called events
          for (const tc of toolCalls) {
            controller.enqueue(encoder.encode(
              sseFrame('tool_called', { tool: tc.name }),
            ));
            controller.enqueue(encoder.encode(
              sseFrame('tool_debug', {
                phase: 'call',
                tool: tc.name,
                id: tc.id,
                argumentsPreview: safeJsonPreview(tc.arguments, 1200),
              }),
            ));
          }

          // Execute tools
          const toolSpans: any[] = [];
          for (const tc of toolCalls) {
            const ts = context.tracer?.startSpan?.(`tool.${tc.name}`, {
              'tool.name': tc.name,
              'tool.call_id': tc.id,
              'tool.arguments_length': tc.arguments.length,
            });
            toolSpans.push(ts);
          }

          try {
            const results = await Promise.all(
              toolCalls.map(async (tc, i) => {
                const startedAt = Date.now();
                const result = await toolRegistry.execute(tc.name, tc.arguments);
                const durationMs = Date.now() - startedAt;

                toolSpans[i]?.setAttributes?.({ 'tool.result_length': result.length });

                const resultPreview = safeJsonPreview(result, 2000);
                const isError = result.includes('"error"');
                controller.enqueue(encoder.encode(
                  sseFrame('tool_debug', {
                    phase: 'result',
                    tool: tc.name,
                    id: tc.id,
                    resultPreview,
                    resultLength: result.length,
                    durationMs,
                    ...(isError ? { error: resultPreview } : {}),
                  }),
                ));

                return result;
              }),
            );

            for (let i = 0; i < toolCalls.length; i++) {
              logger.log(`[tool] ${toolCalls[i].name}: ${results[i].slice(0, 200)}`);
              const toolMsg = {
                role: 'tool',
                tool_call_id: toolCalls[i].id,
                content: results[i],
              };
              logger.log(`[debug] toolMsg[${i}]: ${JSON.stringify(toolMsg)}`);
              messages.push(toolMsg);
            }
          } finally {
            for (const ts of toolSpans) {
              ts?.end?.();
            }
          }
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
          controller.enqueue(encoder.encode(
            sseFrame('error', { message: String(error.message ?? e) }),
          ));
        }
      } finally {
        // Save assistant message if any content was generated
        if (assistantContent) {
          const saveSpan = context.tracer?.startSpan?.('session.save_assistant_message', {
            'session.conversation_id': cid,
            'session.content_length': assistantContent.length,
          });
          try {
            await session.saveAssistantMessage(cid, assistantContent);
          } finally {
            saveSpan?.end?.();
          }
        }

        // Send done frame
        controller.enqueue(encoder.encode(sseFrame('done', { stopped })));
        controller.close();
      }
    },
    cancel() {
      logger.log('[stream] client disconnected');
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
