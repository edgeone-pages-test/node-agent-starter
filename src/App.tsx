import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, ToolLampState } from './types';
import { fetchConversationHistory, sendMessageStream, stopAgent } from './api';
import ToolIndicators from './components/ToolIndicators';
import ChatWindow from './components/ChatWindow';
import ChatInput from './components/ChatInput';
import CodeViewer from './components/CodeViewer';
import styles from './App.module.css';

const INITIAL_LAMPS: ToolLampState[] = [
  { id: 'commands',         label: '命令执行', icon: '💻', active: false, animKey: 0 },
  { id: 'files',            label: '文件操作', icon: '📁', active: false, animKey: 0 },
  { id: 'code_interpreter', label: '代码运行', icon: '⚡', active: false, animKey: 0 },
  { id: 'browser',          label: '浏览器',   icon: '🌐', active: false, animKey: 0 },
];

const CONVERSATION_ID_STORAGE_KEY = 'eo_conversation_id';

function getOrCreateConversationId(): string {
  const cached = localStorage.getItem(CONVERSATION_ID_STORAGE_KEY);
  if (cached) return cached;

  const conversationId = crypto.randomUUID();
  localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, conversationId);
  return conversationId;
}

// ✅ 模块级去重标记 —— 脱离 React 生命周期，StrictMode 无法干扰
let _historyFetchInFlight = false;

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [lamps, setLamps]       = useState<ToolLampState[]>(INITIAL_LAMPS);
  const [loading, setLoading]   = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);

  const botMsgIdRef = useRef<string>('');
  const abortCtrlRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string>(getOrCreateConversationId());
  const lampTimers = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (_historyFetchInFlight) return;
    _historyFetchInFlight = true;

    fetchConversationHistory(conversationIdRef.current).then(history => {
      if (history.length > 0) {
        setMessages(history);
      }
    }).finally(() => {
      _historyFetchInFlight = false;
      setHistoryLoading(false);
    });
  }, []);

  const updateBotMessage = useCallback((updater: (content: string) => string) => {
    setMessages(prev =>
      prev.map(m =>
        m.id === botMsgIdRef.current
          ? { ...m, content: updater(m.content) }
          : m
      )
    );
  }, []);

  const finishStream = useCallback(() => {
    setLoading(false);
    abortCtrlRef.current = null;
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if (loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    const botMsgId = crypto.randomUUID();
    botMsgIdRef.current = botMsgId;
    const botMsg: Message = {
      id: botMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMsg, botMsg]);
    setLoading(true);

    const ctrl = sendMessageStream(text, {
      onTextDelta(delta) {
        updateBotMessage(content => content + delta);
      },

      onToolCalled(toolName) {
        const existing = lampTimers.current.get(toolName);
        if (existing) clearTimeout(existing);
        setLamps(prev => prev.map(l => l.id === toolName ? { ...l, active: true, animKey: l.animKey + 1 } : l));
        const tid = window.setTimeout(() => {
          setLamps(prev => prev.map(l => (l.id === toolName ? { ...l, active: false } : l)));
          lampTimers.current.delete(toolName);
        }, 1000);
        lampTimers.current.set(toolName, tid);
      },

      onDone: finishStream,

      onError() {
        updateBotMessage(content => content || '请求失败，请检查后端服务是否启动。');
        finishStream();
      },
    }, conversationIdRef.current);

    abortCtrlRef.current = ctrl;
  }, [loading, updateBotMessage, finishStream]);

  const handleClearHistory = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    setLoading(false);
    localStorage.removeItem(CONVERSATION_ID_STORAGE_KEY);
    const newId = crypto.randomUUID();
    localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, newId);
    conversationIdRef.current = newId;
    setMessages([]);
  }, []);

  const handleStop = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }

    updateBotMessage(content => content ? content + '\n\n *已停止生成*' : ' *已停止生成*');
    setLoading(false);

    stopAgent(conversationIdRef.current).then(ok => {
      if (!ok) {
        updateBotMessage(content => content + '\n\n 后端中断请求失败，服务端可能仍在运行。');
      }
    });
  }, [updateBotMessage]);

  return (
    <div className={styles.shell}>
      <div className={styles.blob1} />
      <div className={styles.blob2} />

      <div className={styles.stage}>
        <div className={styles.chatPanel}>
          {historyLoading && messages.length === 0 && (
            <div className={styles.historyOverlay}>
              <div className={styles.historySpinner} />
            </div>
          )}
          <header className={styles.header}>
            <div className={styles.headerLeft}>
              <span className={styles.logo}>&#x2B21;</span>
              <div>
                <p className={styles.title}>Agent Chat</p>
                <p className={styles.subtitle}>Node.js Starter -- EdgeOne Pages Functions + Platform Tools</p>
              </div>
            </div>
            <ToolIndicators lamps={lamps} />
          </header>

          <ChatWindow messages={messages} loading={loading} />
          <ChatInput onSend={handleSend} onStop={handleStop} onClear={handleClearHistory} disabled={loading} />
        </div>

        <div className={styles.codePanel}>
          <CodeViewer />
        </div>
      </div>
    </div>
  );
}
