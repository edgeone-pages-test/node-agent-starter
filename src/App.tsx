import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, ToolLampState } from './types';
import { fetchConversationHistory, sendMessageStream, stopAgent } from './api';
import { I18nProvider, LangToggle, useT, MessageKeys } from './i18n';
import ToolIndicators from './components/ToolIndicators';
import ChatWindow from './components/ChatWindow';
import ChatInput from './components/ChatInput';
import CodeViewer from './components/CodeViewer';
import styles from './App.module.css';

const LAMP_IDS = ['commands', 'files', 'code_interpreter', 'browser'] as const;
const LAMP_ICONS: Record<string, string> = { commands: '💻', files: '📁', code_interpreter: '⚡', browser: '🌐' };
const LAMP_I18N_KEYS: Record<string, MessageKeys> = { commands: 'tool.commands', files: 'tool.files', code_interpreter: 'tool.codeRunner', browser: 'tool.browser' };

const CONVERSATION_ID_STORAGE_KEY = 'eo_conversation_id';

function getOrCreateConversationId(): string {
  const cached = localStorage.getItem(CONVERSATION_ID_STORAGE_KEY);
  if (cached) return cached;

  const conversationId = crypto.randomUUID();
  localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, conversationId);
  return conversationId;
}

// Module-level dedup flag — outside React lifecycle, unaffected by StrictMode
let _historyFetchInFlight = false;

function AppInner() {
  const { t } = useT();

  const buildLamps = useCallback((): ToolLampState[] => {
    return LAMP_IDS.map(id => ({
      id,
      label: t(LAMP_I18N_KEYS[id]),
      icon: LAMP_ICONS[id],
      active: false,
      animKey: 0,
    }));
  }, [t]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [lamps, setLamps]       = useState<ToolLampState[]>(buildLamps);
  const [loading, setLoading]   = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);

  const botMsgIdRef = useRef<string>('');
  const abortCtrlRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string>(getOrCreateConversationId());
  const lampTimers = useRef<Map<string, number>>(new Map());

  // Update lamp labels when language changes
  useEffect(() => {
    setLamps(prev => prev.map(l => ({ ...l, label: t(LAMP_I18N_KEYS[l.id]) })));
  }, [t]);

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
        updateBotMessage(content => content || t('status.error'));
        finishStream();
      },
    }, conversationIdRef.current);

    abortCtrlRef.current = ctrl;
  }, [loading, updateBotMessage, finishStream, t]);

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

    updateBotMessage(content => content ? content + '\n\n' + t('status.stopped') : t('status.stopped'));
    setLoading(false);

    stopAgent(conversationIdRef.current).then(ok => {
      if (!ok) {
        updateBotMessage(content => content + '\n\n' + t('status.backendError'));
      }
    });
  }, [updateBotMessage, t]);

  return (
    <div className={styles.shell}>
      <div className={styles.blob1} />
      <div className={styles.blob2} />

      <LangToggle />

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
                <p className={styles.title}>{t('app.title')}</p>
                <p className={styles.subtitle}>{t('app.subtitle')}</p>
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

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
