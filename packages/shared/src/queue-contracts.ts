import type { TelegramUpdate } from './telegram-types.js';

export const QUEUES = {
  TELEGRAM_INBOUND: 'chatmaster:inbound:telegram',
  TELEGRAM_OUTBOUND: 'chatmaster:outbound:telegram',
  TELEGRAM_OUTBOUND_DLQ: 'chatmaster:outbound:telegram:dlq',
} as const;

export interface InboundTelegramJobData {
  platformConnectionId: string;
  tenantId: string;
  botId: string;
  updateId: number;
  update: TelegramUpdate;
  receivedAt: string;
}

export interface ReplyButtonData {
  row: number;
  column: number;
  type: 'URL' | 'CALLBACK';
  label: string;
  url?: string | undefined;
  nextReplyId?: string | undefined;
}

export interface OutboundTelegramJobData {
  tenantId: string;
  platformConnectionId: string;
  chatId: string;
  text: string;
  parseMode?: 'NONE' | 'HTML' | 'MARKDOWN_V2' | undefined;
  buttons?: ReplyButtonData[] | undefined;
  replyToMessageId?: number | undefined;
  correlationUpdateId?: number | undefined;
  workflowId?: string | undefined;
  replyId?: string | undefined;
  /** Set when the reply answers an inline-button press; acknowledged before sending. */
  callbackQueryId?: string | undefined;
}

/** Acknowledges a button press that produced no reply (unknown, stale or disabled target). */
export interface AnswerCallbackJobData {
  tenantId: string;
  platformConnectionId: string;
  callbackQueryId: string;
  text?: string | undefined;
}

export const OUTBOUND_JOBS = {
  REPLY: 'telegram.reply',
  ANSWER_CALLBACK: 'telegram.answer_callback',
} as const;

export interface DeadLetterJobData {
  queue: string;
  jobName: string;
  originalData: unknown;
  error: {
    message: string;
    stack?: string | undefined;
    statusCode?: number | undefined;
  };
  failedAt: string;
  attemptsMade: number;
}
