import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Message, ReplLine, TurnMeta } from './types';
import type { RawSseEvent } from './api';
import { fetchConversationHistory, sendMessageStream, stopAgent } from './api';
import { I18nProvider, useT } from './i18n';
import ReplShell from './components/repl/ReplShell';
import ReplStream from './components/repl/ReplStream';
import ReplPrompt from './components/repl/ReplPrompt';
import {
  makeDone,
  makeError,
  makeMotd,
  makeRestored,
  makeSysHint,
  makeText,
  makeTool,
  makeUser,
  startTurn,
} from './components/repl/lines';
import type { ReplAction } from './components/repl/keymap';
import styles from './App.module.css';

const CONVERSATION_ID_STORAGE_KEY = 'eo_conversation_id';
const MODEL_BANNER = 'hy3-preview'; // visual only; matches default in agents/_model.ts
const MAX_INPUT_HISTORY = 50;

function getExistingConversationId(): string | null {
  return localStorage.getItem(CONVERSATION_ID_STORAGE_KEY);
}

function getOrCreateConversationId(): string {
  const cached = getExistingConversationId();
  if (cached) return cached;
  const id = crypto.randomUUID();
  localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, id);
  return id;
}

/** Map `Message[]` from /history into ReplLine[] (user / text only). */
function historyToLines(history: Message[]): ReplLine[] {
  const out: ReplLine[] = [];
  for (const m of history) {
    if (!m.content && m.role === 'assistant') continue;
    if (m.role === 'user') {
      out.push({ kind: 'user', id: m.id, text: m.content, ts: m.timestamp });
    } else {
      // each restored assistant turn becomes a single text line; we don't have
      // its turnId anymore so we generate a synthetic one.
      out.push({
        kind: 'text',
        id: m.id,
        turnId: `restored-${m.id}`,
        text: m.content,
        ts: m.timestamp,
        // Restored assistant turns only have one text line (no intermediate
        // tool events were stored), so they always carry the agent▸ prefix.
        isContinuation: false,
      });
    }
  }
  return out;
}

function tplFill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

// Module-level dedup flag — outside React lifecycle, unaffected by StrictMode
let _historyFetchInFlight = false;

function AppInner() {
  const { t } = useT();

  const [lines, setLines] = useState<ReplLine[]>(() => [makeMotd()]);
  const [traceEvents, setTraceEvents] = useState<RawSseEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [verbose, setVerbose] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);

  const turnMetaRef = useRef<TurnMeta | null>(null);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string>(getOrCreateConversationId());
  const clearInputRef = useRef<() => void>(() => {});
  const verboseRef = useRef<boolean>(false);

  // Restore conversation history on mount (skip on first visit).
  useEffect(() => {
    if (!getExistingConversationId() || _historyFetchInFlight) {
      // Even if there's no cached id, we created one via getOrCreateConversationId,
      // but if it's a fresh one we haven't sent any messages, so /history would
      // return empty. We still flip historyLoading off and skip the call.
      // Detect "fresh" by checking that getExistingConversationId was null prior;
      // since we already wrote it in getOrCreateConversationId, use a sentinel:
      setHistoryLoading(false);
      return;
    }
    _historyFetchInFlight = true;
    fetchConversationHistory(conversationIdRef.current)
      .then(history => {
        if (history.length > 0) {
          const restored = historyToLines(history);
          const marker = makeRestored(history.length);
          setLines(prev => [...prev, ...restored, marker]);
        }
      })
      .finally(() => {
        _historyFetchInFlight = false;
        setHistoryLoading(false);
      });
    // We intentionally run only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── SSE handlers (turn-scoped) ─────────────────────────────────────
  const finishStream = useCallback(() => {
    setLoading(false);
    abortCtrlRef.current = null;
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      if (loading) return;

      // Push user echo + start a new turn
      const userLine = makeUser(text);
      setLines(prev => [...prev, userLine]);
      setInputHistory(prev => {
        const next = [...prev.filter(s => s !== text), text];
        return next.length > MAX_INPUT_HISTORY ? next.slice(-MAX_INPUT_HISTORY) : next;
      });

      const turnId = crypto.randomUUID();
      turnMetaRef.current = startTurn(turnId);
      setLoading(true);

      const ctrl = sendMessageStream(
        text,
        {
          onTextDelta: delta => {
            const meta = turnMetaRef.current;
            if (!meta) return;

            // CRITICAL: do NOT generate ids or mutate refs *inside* the
            // setLines updater. React 18 StrictMode invokes updaters twice
            // in dev; any side-effect (UUID generation, ref mutation) makes
            // the two calls disagree and React keeps only the second return.
            //
            // We decide the target line id BEFORE setLines, mutate the ref
            // at the same time, then run a pure updater.
            if (meta.currentTextLineId === null) {
              // Continuation = a text line that comes AFTER a tool call in the
              // same turn. The very first text line of the turn gets the
              // agent▸ prefix; later segments don't, to avoid visual noise.
              const isContinuation = meta.toolRounds > 0;
              const fresh = makeText(meta.turnId, '', isContinuation);
              meta.currentTextLineId = fresh.id;
              meta.hasText = true;
              setLines(prev => [...prev, { ...fresh, text: delta }]);
            } else {
              const target = meta.currentTextLineId;
              meta.hasText = true;
              setLines(prev =>
                prev.map(l =>
                  l.kind === 'text' && l.id === target ? { ...l, text: l.text + delta } : l,
                ),
              );
            }
          },

          onToolCalled: toolName => {
            const meta = turnMetaRef.current;
            if (!meta) return;
            // Each tool call ends the current text line; the next text_delta
            // will start a fresh one.
            meta.currentTextLineId = null;
            meta.toolRounds += 1;
            // Build the line OUTSIDE the updater so its id is stable across
            // StrictMode's double invocation.
            const toolLine = makeTool(meta.turnId, toolName);
            setLines(prev => [...prev, toolLine]);
          },

          onRawEvent: ev => {
            // Coalesce consecutive text_delta events into a single growing entry,
            // so a multi-paragraph response doesn't flood the trace panel with
            // hundreds of one-token rows.
            if (ev.eventType === 'text_delta') {
              const delta = (ev.data as { delta?: string } | null)?.delta ?? '';
              setTraceEvents(prev => {
                const last = prev[prev.length - 1];
                if (last && last.eventType === 'text_delta') {
                  const prevDelta = (last.data as { delta?: string } | null)?.delta ?? '';
                  const merged: RawSseEvent = {
                    ...last,
                    data: { delta: prevDelta + delta },
                    raw: last.raw + delta,
                    timestamp: ev.timestamp,
                  };
                  return [...prev.slice(0, -1), merged];
                }
                return [...prev, ev];
              });
              return;
            }
            // Mirror to trace buffer for verbose mode.
            setTraceEvents(prev => [...prev, ev]);
          },

          onDone: () => {
            const meta = turnMetaRef.current;
            if (meta) {
              const doneLine = makeDone(meta.turnId, meta.startTs, meta.toolRounds);
              setLines(prev => [...prev, doneLine]);
              turnMetaRef.current = null;
            }
            finishStream();
          },

          onError: err => {
            const meta = turnMetaRef.current;
            const errLine = makeError(err.message || t('status.error'), meta?.turnId);
            const padLine =
              meta && !meta.hasText ? makeText(meta.turnId, '', true) : null;
            setLines(prev => (padLine ? [...prev, errLine, padLine] : [...prev, errLine]));
            if (meta) turnMetaRef.current = null;
            finishStream();
          },
        },
        conversationIdRef.current,
      );

      abortCtrlRef.current = ctrl;
    },
    [loading, t, finishStream],
  );

  // ─── Action handlers (keyboard) ─────────────────────────────────────
  const handleStop = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    const meta = turnMetaRef.current;
    const abortLine = makeSysHint(t('repl.status.aborted'), 'warn');
    setLines(prev => [...prev, abortLine]);
    setLoading(false);

    stopAgent(conversationIdRef.current).then(ok => {
      const ackLine = makeSysHint(
        ok ? t('repl.status.stopOk') : t('repl.status.stopFail'),
        ok ? 'dim' : 'error',
      );
      setLines(prev => [...prev, ackLine]);
    });
    if (meta) turnMetaRef.current = null;
  }, [t]);

  const handleClearScreen = useCallback(() => {
    const motd = makeMotd();
    const hint = makeSysHint(t('repl.status.cleared'));
    setLines([motd, hint]);
  }, [t]);

  const handleResetSession = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    setLoading(false);
    localStorage.removeItem(CONVERSATION_ID_STORAGE_KEY);
    const newId = crypto.randomUUID();
    localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, newId);
    conversationIdRef.current = newId;
    turnMetaRef.current = null;
    setTraceEvents([]);
    const motd = makeMotd();
    const hint = makeSysHint(t('repl.status.reset'), 'warn');
    setLines([motd, hint]);
  }, [t]);

  const handleToggleVerbose = useCallback(() => {
    // Compute next value via ref to avoid nesting setLines inside a setVerbose
    // updater (which StrictMode invokes twice → would append the hint twice).
    const next = !verboseRef.current;
    verboseRef.current = next;
    setVerbose(next);
    const hint = makeSysHint(next ? t('repl.status.verboseOn') : t('repl.status.verboseOff'));
    setLines(prev => [...prev, hint]);
  }, [t]);

  const handleShowHelp = useCallback(() => {
    const h1 = makeSysHint(`— ${t('repl.help.title')} —`);
    const h2 = makeSysHint(t('repl.help.body'));
    setLines(prev => [...prev, h1, h2]);
  }, [t]);

  const onAction = useCallback(
    (action: ReplAction) => {
      switch (action) {
        case 'abort':
          handleStop();
          return;
        case 'clearInput':
          clearInputRef.current?.();
          return;
        case 'clearScreen':
          handleClearScreen();
          return;
        case 'resetSession':
          handleResetSession();
          return;
        case 'toggleVerbose':
          handleToggleVerbose();
          return;
        case 'showHelp':
          handleShowHelp();
          return;
      }
    },
    [handleStop, handleClearScreen, handleResetSession, handleToggleVerbose, handleShowHelp],
  );

  const registerClearInput = useCallback((fn: () => void) => {
    clearInputRef.current = fn;
  }, []);

  const historyHint = useMemo(() => {
    const id = conversationIdRef.current.slice(0, 8);
    return tplFill(t('repl.status.restoring'), { id, n: 0 });
  }, [t]);

  return (
    <div className={styles.app}>
      <ReplShell
        modelName={MODEL_BANNER}
        loading={loading}
        historyLoading={historyLoading}
        historyHint={historyHint}
        onAction={onAction}
        footer={
          <ReplPrompt
            loading={loading}
            onSubmit={handleSend}
            onStop={handleStop}
            registerClearInput={registerClearInput}
            inputHistory={inputHistory}
          />
        }
      >
        <ReplStream lines={lines} traceEvents={traceEvents} verbose={verbose} />
      </ReplShell>
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
