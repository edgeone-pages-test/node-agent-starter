import { memo } from 'react';
import type { Message } from '../types';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './ChatBubble.module.css';

interface Props {
  message: Message;
}

export default memo(function ChatBubble({ message }: Props) {
  const isUser = message.role === 'user';

  if (!isUser && !message.content) return null;

  return (
    <div className={`${styles.row} ${isUser ? styles.userRow : styles.botRow}`}>
      {!isUser && <div className={styles.avatar}>&#x2B21;</div>}
      <div className={`${styles.bubble} ${isUser ? styles.userBubble : styles.botBubble}`}>
        {isUser ? (
          message.content
        ) : (
          <div className={styles.markdown}>
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          </div>
        )}
        <span className={styles.time}>
          {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {isUser && <div className={`${styles.avatar} ${styles.userAvatar}`}>&#x4F60;</div>}
    </div>
  );
});
