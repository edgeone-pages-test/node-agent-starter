/**
 * Tools module -- private module (starts with _), not mapped as a route.
 *
 * Extracts EdgeOne platform tools from context.tools and converts them to
 * OpenAI-compatible function calling format for the chat/completions API.
 *
 * EdgeOne provides sandbox tools: commands, files, code_interpreter, browser.
 */

interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOL_SCHEMAS: Record<string, ToolSchema> = {
  commands: {
    type: 'function',
    function: {
      name: 'commands',
      description: 'Execute a shell command in the EdgeOne sandbox environment',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['cmd'],
      },
    },
  },
  files: {
    type: 'function',
    function: {
      name: 'files',
      description: 'Perform file operations in the EdgeOne sandbox: read, write, list, exists, remove, makeDir',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['read', 'write', 'list', 'exists', 'remove', 'makeDir'],
            description: 'File operation to perform',
          },
          path: { type: 'string', description: 'File or directory path' },
          content: { type: 'string', description: 'Content for write operation' },
        },
        required: ['op', 'path'],
      },
    },
  },
  code_interpreter: {
    type: 'function',
    function: {
      name: 'code_interpreter',
      description: 'Run code in an isolated interpreter in the EdgeOne sandbox',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript', 'r', 'bash'],
            description: 'Programming language to execute',
          },
          code: { type: 'string', description: 'Source code to execute' },
        },
        required: ['language', 'code'],
      },
    },
  },
  browser: {
    type: 'function',
    function: {
      name: 'browser',
      description: 'Interact with web pages in the EdgeOne sandbox: fetch, screenshot, click, type, evaluate',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['fetch', 'screenshot', 'click', 'type', 'evaluate'],
            description: 'Browser operation to perform',
          },
          url: { type: 'string', description: 'Target URL (for fetch)' },
          selector: { type: 'string', description: 'CSS selector' },
          text: { type: 'string', description: 'Text to type' },
          script: { type: 'string', description: 'JavaScript to evaluate' },
        },
        required: ['op'],
      },
    },
  },
};

/**
 * Registry holding tool schemas and handlers extracted from context.tools.
 */
export class ToolRegistry {
  tools: ToolSchema[] = [];
  private handlers: Map<string, (args: Record<string, unknown>) => unknown> = new Map();

  hasTools(): boolean {
    return this.tools.length > 0;
  }

  register(name: string, schema: ToolSchema, handler: (args: Record<string, unknown>) => unknown): void {
    if (this.handlers.has(name)) return;
    this.tools.push(schema);
    this.handlers.set(name, handler);
  }

  async execute(name: string, arguments_: string): Promise<string> {
    const handler = this.handlers.get(name);
    if (!handler) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    let args: Record<string, unknown> = {};
    try {
      args = arguments_ ? JSON.parse(arguments_) : {};
    } catch {
      args = {};
    }

    try {
      let result = handler(args);
      if (result && typeof result === 'object' && 'then' in result) {
        result = await (result as Promise<unknown>);
      }
      return stringifyResult(result);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ error: `Tool execution failed: ${message}` });
    }
  }
}

/**
 * Build a ToolRegistry from EdgeOne's context.tools.
 */
export function buildTools(context: any, logger?: any): ToolRegistry {
  const registry = new ToolRegistry();

  const runtimeTools = context?.tools;
  if (logger) {
    logger.log(`[tools] context.tools = ${runtimeTools}`);
    logger.log(`[tools] context.tools type = ${typeof runtimeTools}`);
  }

  if (!runtimeTools || typeof runtimeTools.all !== 'function') {
    if (logger) {
      logger.log(`[tools] no EdgeOne platform tools available`);
    }
    return registry;
  }

  const rawTools = runtimeTools.all();
  if (logger) {
    logger.log(`[tools] raw_tools count: ${rawTools?.length ?? 0}`);
  }

  for (const item of rawTools || []) {
    const name: string | undefined = item?.name ?? item?.function?.name;
    const schema = TOOL_SCHEMAS[name || ''];
    const handler = item?.execute ?? item?.handler ?? item?.invoke;

    if (logger) {
      logger.log(`[tools] inspecting: name=${name}, has_schema=${!!schema}, callable=${typeof handler === 'function'}`);
    }

    if (!name || !schema || typeof handler !== 'function') {
      if (logger) {
        logger.log(`[tools] skipped: ${name || '<unknown>'}`);
      }
      continue;
    }

    registry.register(name, schema, handler);
    if (logger) {
      logger.log(`[tools] registered: ${name}`);
    }
  }

  return registry;
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
