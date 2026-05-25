import type React from 'react';
import styles from './CodeViewer.module.css';

/* Token factory */
const token = (cls: string) =>
  function Token({ t }: { t: string }) { return <span className={cls}>{t}</span>; };

const Cmt = token(styles.cmt);
const Kw  = token(styles.kw);
const Fn  = token(styles.fn);
const Ty  = token(styles.ty);
const Str = token(styles.str);
const Op  = token(styles.op);
const Va  = token(styles.va);

interface LineProps { n: number; children?: React.ReactNode }
const L = ({ n, children }: LineProps) => (
  <div className={styles.line}>
    <span className={styles.ln}>{String(n).padStart(2, ' ')}</span>
    <span className={styles.lc}>{children ?? ' '}</span>
  </div>
);

const I = () => <span className={styles.indent} />;
const I2 = () => <><span className={styles.indent} /><span className={styles.indent} /></>;
const I3 = () => <><span className={styles.indent} /><span className={styles.indent} /><span className={styles.indent} /></>;

export default function CodeViewer() {
  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.fileIcon}>&#x2B21;</span>
          <span className={styles.filename}>agents/chat/index.ts</span>
        </div>
        <span className={styles.badge}>READ ONLY</span>
      </div>

      {/* Code body */}
      <div className={styles.body}>
        <div className={styles.scanline} aria-hidden />

        <div className={styles.code}>
          {/* Imports */}
          <L n={1}>
            <Kw t="import " /><Op t="{ " /><Fn t="getModelConfig" /><Op t=" } " />
            <Kw t="from " /><Str t="'../_model'" /><Op t=";" />
          </L>
          <L n={2}>
            <Kw t="import " /><Op t="{ " /><Ty t="ChatSession" /><Op t=" } " />
            <Kw t="from " /><Str t="'../_session'" /><Op t=";" />
          </L>
          <L n={3}>
            <Kw t="import " /><Op t="{ " /><Fn t="buildTools" /><Op t=" } " />
            <Kw t="from " /><Str t="'../_tools'" /><Op t=";" />
          </L>
          <L n={4} />

          {/* SYSTEM_PROMPT */}
          <L n={5}>
            <Kw t="const " /><Va t="SYSTEM_PROMPT" /><Op t=" = " /><Str t="`...`" /><Op t=";" />
          </L>
          <L n={6} />

          {/* onRequest */}
          <L n={7}>
            <Kw t="export " /><Kw t="async " /><Kw t="function " /><Fn t="onRequest" />
            <Op t="(" /><Va t="context" /><Op t=": " /><Ty t="any" /><Op t=") {" />
          </L>
          <L n={8}>
            <I /><Kw t="const " /><Va t="message" /><Op t=" = " />
            <Va t="context" /><Op t="." /><Va t="request" /><Op t="." /><Va t="body" />
            <Op t="?." /><Va t="message" /><Op t=" ?? " /><Str t="''" /><Op t=";" />
          </L>
          <L n={9}>
            <I /><Kw t="const " /><Va t="conversationId" /><Op t=" = " />
            <Va t="context" /><Op t="." /><Va t="conversation_id" /><Op t=";" />
          </L>
          <L n={10} />

          {/* Step 1: EdgeOne Store */}
          <L n={11}>
            <I /><Cmt t="// 1. EdgeOne Store: load history + save user message" />
          </L>
          <L n={12}>
            <I /><Kw t="const " /><Va t="session" /><Op t=" = " />
            <Kw t="new " /><Ty t="ChatSession" /><Op t="(" /><Va t="context" /><Op t="." /><Va t="store" /><Op t=");" />
          </L>
          <L n={13}>
            <I /><Kw t="const " /><Va t="history" /><Op t=" = " />
            <Kw t="await " /><Va t="session" /><Op t="." /><Fn t="getHistory" />
            <Op t="(" /><Va t="conversationId" /><Op t=");" />
          </L>
          <L n={14}>
            <I /><Kw t="await " /><Va t="session" /><Op t="." /><Fn t="saveUserMessage" />
            <Op t="(" /><Va t="conversationId" /><Op t=", " /><Va t="message" /><Op t=");" />
          </L>
          <L n={15} />

          {/* Messages array */}
          <L n={16}>
            <I /><Kw t="const " /><Va t="messages" /><Op t=" = [" />
          </L>
          <L n={17}>
            <I2 /><Op t="{ " /><Va t="role" /><Op t=": " /><Str t="'system'" />
            <Op t=", " /><Va t="content" /><Op t=": " /><Va t="SYSTEM_PROMPT" /><Op t=" }," />
          </L>
          <L n={18}>
            <I2 /><Op t="..." /><Va t="history" /><Op t="," />
          </L>
          <L n={19}>
            <I2 /><Op t="{ " /><Va t="role" /><Op t=": " /><Str t="'user'" />
            <Op t=", " /><Va t="content" /><Op t=": " /><Va t="message" /><Op t=" }," />
          </L>
          <L n={20}>
            <I /><Op t="];" />
          </L>
          <L n={21} />

          {/* Step 2: Tools */}
          <L n={22}>
            <I /><Cmt t="// 2. EdgeOne Tools: extract platform sandbox tools as function calling tools" />
          </L>
          <L n={23}>
            <I /><Kw t="const " /><Va t="toolRegistry" /><Op t=" = " />
            <Fn t="buildTools" /><Op t="(" /><Va t="context" /><Op t=");" />
          </L>
          <L n={24} />

          {/* Step 3: Fetch LLM */}
          <L n={25}>
            <I /><Cmt t="// 3. Call OpenAI-compatible LLM" />
          </L>
          <L n={26}>
            <I /><Kw t="const " /><Va t="response" /><Op t=" = " /><Kw t="await " />
            <Fn t="fetch" /><Op t="(" /><Str t="`${modelConfig.baseUrl}/chat/completions`" /><Op t=", {" />
          </L>
          <L n={27}>
            <I2 /><Va t="method" /><Op t=": " /><Str t="'POST'" /><Op t="," />
          </L>
          <L n={28}>
            <I2 /><Va t="body" /><Op t=": " /><Fn t="JSON.stringify" />
            <Op t="({ " /><Va t="messages" /><Op t=", " /><Va t="tools" />
            <Op t=", " /><Va t="stream" /><Op t=": " /><Kw t="true" /><Op t=" })," />
          </L>
          <L n={29}>
            <I2 /><Va t="signal" /><Op t=": " /><Va t="context" /><Op t="." /><Va t="request" /><Op t="." /><Va t="signal" /><Op t="," />
          </L>
          <L n={30}>
            <I /><Op t="});" />
          </L>
          <L n={31} />

          {/* Step 4: Handle tool_calls */}
          <L n={32}>
            <I /><Cmt t="// 4. Handle response: text or tool_calls" />
          </L>
          <L n={33}>
            <I /><Kw t="const " /><Va t="assistantMessage" /><Op t=" = " /><Kw t="await " />
            <Fn t="readAssistantMessage" /><Op t="(" /><Va t="response" /><Op t=");" />
          </L>
          <L n={34} />
          <L n={35}>
            <I /><Kw t="if " /><Op t="(" /><Va t="assistantMessage" /><Op t="." /><Va t="tool_calls" />
            <Op t="?." /><Va t="length" /><Op t=") {" />
          </L>
          <L n={36}>
            <I2 /><Kw t="for " /><Op t="(" /><Kw t="const " /><Va t="toolCall" />
            <Kw t=" of " /><Va t="assistantMessage" /><Op t="." /><Va t="tool_calls" /><Op t=") {" />
          </L>
          <L n={37}>
            <I3 /><Cmt t="// Execute EdgeOne sandbox tool (commands/files/browser/code_interpreter)" />
          </L>
          <L n={38}>
            <I3 /><Kw t="const " /><Va t="toolResult" /><Op t=" = " /><Kw t="await " />
            <Va t="toolRegistry" /><Op t="." /><Fn t="execute" />
            <Op t="(" /><Va t="name" /><Op t=", " /><Va t="args" /><Op t=");" />
          </L>
          <L n={39}>
            <I3 /><Va t="messages" /><Op t="." /><Fn t="push" />
            <Op t="({ " /><Va t="role" /><Op t=": " /><Str t="'tool'" /><Op t=", " />
            <Va t="tool_call_id" /><Op t=", " /><Va t="content" /><Op t=": " />
            <Va t="toolResult" /><Op t=" });" />
          </L>
          <L n={40}>
            <I2 /><Op t="}" />
          </L>
          <L n={41}>
            <I2 /><Cmt t="// Continue sending tool results back to the model until final answer" />
          </L>
          <L n={42}>
            <I /><Op t="}" />
          </L>
          <L n={43} />

          {/* Step 5: Save assistant message */}
          <L n={44}>
            <I /><Cmt t="// 5. EdgeOne Store: save assistant reply for /history restore" />
          </L>
          <L n={45}>
            <I /><Kw t="await " /><Va t="session" /><Op t="." /><Fn t="saveAssistantMessage" />
            <Op t="(" /><Va t="conversationId" /><Op t=", " /><Va t="content" /><Op t=");" />
          </L>
          <L n={46} />
          <L n={47}>
            <I /><Kw t="return " /><Ty t="Response" /><Op t="." /><Fn t="json" />
            <Op t="({ " /><Va t="answer" /><Op t=": " /><Va t="content" /><Op t=" });" />
          </L>
          <L n={48}><Op t="}" /></L>
        </div>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <span className={styles.footerDot} />
        <span>Raw fetch + Tool Loop &middot; EdgeOne Functions</span>
      </div>
    </div>
  );
}
