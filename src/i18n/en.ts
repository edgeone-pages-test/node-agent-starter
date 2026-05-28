const en = {
  // Header
  "app.title": "Node.js Starter",
  "app.subtitle": "Node.js Starter -- EdgeOne Makers + Platform Tools",

  // Empty state
  "empty.title": "Node.js Starter",
  "empty.hint": "I'm an Agent running on EdgeOne, using native fetch for streaming chat and tool calling loops. Supports commands, files, code_interpreter, and browser sandbox tools.",
  "empty.features": "EdgeOne Store · Session Memory · Platform Tools",

  // Chat input
  "chat.placeholder": "Send a message... Enter to send, Shift+Enter for newline",
  "chat.hint": "Raw fetch + tool loop · EdgeOne Platform Tools",

  // Preset questions
  "preset.1": "Use terminal commands to check the current system time and OS info",
  "preset.2": "Create a hello.txt file in the sandbox with content \"Hello EdgeOne!\", then read it back",
  "preset.3": "Use Python to calculate and print the first 20 Fibonacci numbers",
  "preset.4": "Use the browser to fetch the page title of https://edgeone.ai",

  // Tool indicators
  "tool.commands": "Commands",
  "tool.files": "Files",
  "tool.codeRunner": "Code Runner",
  "tool.browser": "Browser",

  // Status & errors
  "status.error": "Request failed. Please check if the backend service is running.",
  "status.stopped": " *Generation stopped*",
  "status.backendError": "Backend abort request failed. The server may still be running.",

  // Language toggle
  "lang.switch": "中文",

  // Trace panel
  "trace.title": "Trace",
  "trace.events": "events",
  "trace.clear": "Clear",
  "trace.empty": "Waiting for SSE events...",
  "trace.emptyHint": "After sending a message, raw backend SSE data will be displayed here.",
} as const;

export default en;
