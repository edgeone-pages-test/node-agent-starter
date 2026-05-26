const zh = {
  // Header
  "app.title": "Agent 聊天",
  "app.subtitle": "Node.js Starter -- EdgeOne Pages Functions + 平台工具",

  // Empty state
  "empty.title": "Node.js Starter",
  "empty.hint": "我是运行在 EdgeOne 上的 Agent，使用原生 fetch 实现流式聊天和工具调用循环。支持命令行、文件、代码解释器和浏览器沙箱工具。",
  "empty.features": "EdgeOne Store · 会话记忆 · 平台工具",

  // Chat input
  "chat.placeholder": "输入消息... Enter 发送，Shift+Enter 换行",
  "chat.hint": "原生 fetch + 工具循环 · EdgeOne 平台工具",

  // Preset questions
  "preset.1": "使用终端命令检查当前系统时间和操作系统信息",
  "preset.2": "在沙箱中创建 hello.txt 文件，内容为 \"Hello EdgeOne!\"，然后读取它",
  "preset.3": "使用 Python 计算并打印前 20 个斐波那契数",
  "preset.4": "使用浏览器获取 https://edgeone.ai 的页面标题",

  // Tool indicators
  "tool.commands": "命令行",
  "tool.files": "文件",
  "tool.codeRunner": "代码运行",
  "tool.browser": "浏览器",

  // Status & errors
  "status.error": "请求失败，请检查后端服务是否正常运行。",
  "status.stopped": " *已停止生成*",
  "status.backendError": "后端中止请求失败，服务器可能仍在运行。",

  // Language toggle
  "lang.switch": "English",
} as const;

export default zh;
