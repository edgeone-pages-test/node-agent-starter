/**
 * Chat handler -- EdgeOne Pages Functions
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
  '你是一个运行在 EdgeOne 沙箱环境中的助手。\n' +
  '你可以使用以下 EdgeOne 平台工具：\n' +
  '- commands: 在沙箱中执行 shell 命令（例如 date、ls、uname、curl 等）。\n' +
  '  参数：cmd（必填，要执行的命令），cwd（可选，工作目录）。\n' +
  '- files: 在沙箱中进行文件操作，包括 read、write、list、exists、remove、makeDir。\n' +
  '  参数：op（必填，操作类型），path（多数操作必填，文件或目录路径），content（write 时使用）。\n' +
  '- code_interpreter: 在隔离解释器中运行代码。\n' +
  '  参数：language（例如 python、javascript、bash），code（要执行的源码）。\n' +
  '- browser: 与网页交互，包括 fetch、screenshot、click、type、evaluate。\n' +
  '  参数：op（必填，操作类型），url（fetch 使用），selector、text、script。\n\n' +
  '当工具能够帮助你更具体、准确地回答用户问题时，请主动使用工具。\n' +
  '一次只调用一个工具。不要模拟或伪造工具输出，必须实际调用工具获取结果。\n' +
  '不要使用上述列表之外的任何工具。';

// Maximum number of tool call rounds to prevent infinite loops
const MAX_TOOL_ROUNDS = 10;

const encoder = new TextEncoder();

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
  context.tracer?.set_attributes?.({
    'agent.scenario': 'node_starter_chat',
    'chat.conversation_id': cid,
    'chat.has_message': !!rawMessage,
  });

  if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
    return new Response(
      encoder.encode(sseFrame('error', { message: '消息不能为空' }) + sseFrame('done', {})),
      { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    );
  }
  const message = rawMessage.slice(0, 10000);

  // Get platform cancel signal
  const signal: AbortSignal | undefined = context.request.signal;

  // Session: load history + save user message
  const session = new ChatSession(context.store);

  const sessionSpan = context.tracer?.start_span?.('session.load_and_save', {
    'session.conversation_id': cid,
  });
  let history: Array<{ role: string; content: string }> = [];
  try {
    const [hist] = await Promise.all([
      session.getHistory(cid),
      session.saveUserMessage(cid, message),
    ]);
    history = hist;
    sessionSpan?.set_attributes?.({ 'session.history_count': history.length });
  } finally {
    sessionSpan?.end?.();
  }

  // Tools: build registry from EdgeOne platform tools
  const toolsSpan = context.tracer?.start_span?.('tools.build');
  let toolRegistry: ReturnType<typeof buildTools>;
  try {
    toolRegistry = buildTools(context, logger);
    toolsSpan?.set_attributes?.({
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

          // Tracer: LLM request span
          const llmSpan = context.tracer?.start_span?.(`llm.request.round_${roundIdx + 1}`, {
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
              llmSpan?.set_attributes?.({ 'http.status_code': response.status, 'llm.error': true });
              controller.enqueue(encoder.encode(
                sseFrame('error', { message: `LLM API error: ${response.status}` }),
              ));
              break;
            }

            llmSpan?.set_attributes?.({ 'http.status_code': 200 });

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
            llmSpan?.set_attributes?.({
              'llm.response.content_length': roundContent.length,
              'llm.response.has_tool_calls': !!toolCalls,
            });
            llmSpan?.end?.();
          }

          if (stopped) break;

          // No tool calls -> done
          if (!toolCalls || toolCalls.length === 0) break;

          // Append assistant message with tool_calls
          const assistantMsg: Record<string, any> = { role: 'assistant' };
          if (roundContent) assistantMsg.content = roundContent;
          assistantMsg.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
          messages.push(assistantMsg);

          // Emit tool_called events
          for (const tc of toolCalls) {
            controller.enqueue(encoder.encode(
              sseFrame('tool_called', { tool: tc.name }),
            ));
          }

          // Execute tools
          const toolSpans: any[] = [];
          for (const tc of toolCalls) {
            const ts = context.tracer?.start_span?.(`tool.${tc.name}`, {
              'tool.name': tc.name,
              'tool.call_id': tc.id,
              'tool.arguments_length': tc.arguments.length,
            });
            toolSpans.push(ts);
          }

          try {
            const results = await Promise.all(
              toolCalls.map(tc => toolRegistry.execute(tc.name, tc.arguments)),
            );
            for (let i = 0; i < toolSpans.length; i++) {
              toolSpans[i]?.set_attributes?.({ 'tool.result_length': results[i].length });
            }

            for (let i = 0; i < toolCalls.length; i++) {
              logger.log(`[tool] ${toolCalls[i].name}: ${results[i].slice(0, 200)}`);
              messages.push({
                role: 'tool',
                tool_call_id: toolCalls[i].id,
                content: results[i],
              });
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
          context.tracer?.record_exception?.(error);
          controller.enqueue(encoder.encode(
            sseFrame('error', { message: String(error.message ?? e) }),
          ));
        }
      } finally {
        // Save assistant message if any content was generated
        if (assistantContent) {
          const saveSpan = context.tracer?.start_span?.('session.save_assistant_message', {
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
