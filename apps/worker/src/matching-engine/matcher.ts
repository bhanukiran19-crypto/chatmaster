import type { ButtonType, ParseMode, TriggerType } from '@chatmaster/db';
import { decodeReplyCallbackData, type TelegramUpdate } from '@chatmaster/shared';

export interface WorkflowReplyButtonView {
  id: string;
  row: number;
  column: number;
  type: ButtonType;
  label: string;
  url: string | null;
  nextReplyId: string | null;
}

export interface WorkflowReplyView {
  id: string;
  position: number;
  text: string;
  parseMode: ParseMode;
  buttons: WorkflowReplyButtonView[];
}

export interface WorkflowTriggerView {
  id: string;
  type: TriggerType;
  value: string | null;
  caseInsensitive: boolean;
  position: number;
}

export interface WorkflowView {
  id: string;
  enabled: boolean;
  priority: number;
  cooldownSeconds: number;
  triggers: WorkflowTriggerView[];
  replies: WorkflowReplyView[];
}

/** The parts of a Telegram update the engine reacts to. */
export type InboundEvent =
  | { kind: 'message'; chatId: string; text: string; messageId: number }
  | {
      kind: 'callback';
      chatId: string;
      callbackQueryId: string;
      data: string | undefined;
      messageId: number | undefined;
    };

export type MatchResult =
  | {
      kind: 'trigger';
      workflow: WorkflowView;
      trigger: WorkflowTriggerView;
      reply: WorkflowReplyView;
    }
  | {
      kind: 'callback';
      workflow: WorkflowView;
      button: WorkflowReplyButtonView;
      reply: WorkflowReplyView;
    };

/** `/cmd`, `/cmd@bot_name`, optionally followed by whitespace and arguments. */
const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s|$)/;

export function toInboundEvent(update: TelegramUpdate): InboundEvent | null {
  if (update.message) {
    return {
      kind: 'message',
      chatId: String(update.message.chat.id),
      text: update.message.text ?? '',
      messageId: update.message.message_id,
    };
  }
  const query = update.callback_query;
  if (query) {
    return {
      kind: 'callback',
      // Inline-mode messages have no chat; reply to the presser's private chat.
      chatId: String(query.message?.chat.id ?? query.from.id),
      callbackQueryId: query.id,
      data: query.data,
      messageId: query.message?.message_id,
    };
  }
  return null;
}

/**
 * NFC first so composed and decomposed forms of the same character compare
 * equal (e.g. "é" typed on different keyboards), then optionally lower-case.
 */
export function normalizeText(value: string, caseInsensitive: boolean): string {
  const normalized = value.normalize('NFC');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/** Returns the command name without slash or @bot suffix, or null for non-commands. */
export function parseCommand(text: string): string | null {
  return COMMAND_RE.exec(text)?.[1] ?? null;
}

export function matchesTrigger(trigger: WorkflowTriggerView, rawText: string): boolean {
  const text = rawText.trim();
  if (!text) return false;

  switch (trigger.type) {
    case 'START':
      return parseCommand(text)?.toLowerCase() === 'start';

    case 'COMMAND': {
      const command = parseCommand(text);
      const expected = trigger.value?.trim().replace(/^\//, '');
      if (!command || !expected) return false;
      return (
        normalizeText(command, trigger.caseInsensitive) ===
        normalizeText(expected, trigger.caseInsensitive)
      );
    }

    case 'EXACT': {
      const expected = trigger.value?.trim();
      if (!expected) return false;
      return (
        normalizeText(text, trigger.caseInsensitive) ===
        normalizeText(expected, trigger.caseInsensitive)
      );
    }

    case 'CONTAINS': {
      const needle = trigger.value?.trim();
      if (!needle) return false;
      return normalizeText(text, trigger.caseInsensitive).includes(
        normalizeText(needle, trigger.caseInsensitive),
      );
    }

    case 'ANY':
      return true;

    default:
      return false;
  }
}

/** Enabled workflows in evaluation order: priority ascending, id as a stable tie-breaker. */
export function evaluationOrder(workflows: readonly WorkflowView[]): WorkflowView[] {
  return workflows
    .filter((workflow) => workflow.enabled)
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function primaryReply(workflow: WorkflowView): WorkflowReplyView | undefined {
  return workflow.replies.find((reply) => reply.position === 0);
}

function matchMessage(workflows: readonly WorkflowView[], text: string): MatchResult | null {
  for (const workflow of evaluationOrder(workflows)) {
    const reply = primaryReply(workflow);
    if (!reply) continue;
    const triggers = [...workflow.triggers].sort((a, b) => a.position - b.position);
    const trigger = triggers.find((candidate) => matchesTrigger(candidate, text));
    if (trigger) return { kind: 'trigger', workflow, trigger, reply };
  }
  return null;
}

/**
 * Callback data is client-controlled, so a reply is only reachable when an
 * enabled workflow both owns it and links to it from one of its own CALLBACK
 * buttons. That stops forged payloads from jumping to arbitrary replies.
 */
function matchCallback(
  workflows: readonly WorkflowView[],
  data: string | undefined,
): MatchResult | null {
  const targetReplyId = decodeReplyCallbackData(data);
  if (!targetReplyId) return null;

  for (const workflow of evaluationOrder(workflows)) {
    const reply = workflow.replies.find(
      (candidate) => candidate.id.toLowerCase() === targetReplyId,
    );
    if (!reply) continue;
    for (const source of workflow.replies) {
      const button = source.buttons.find(
        (candidate) =>
          candidate.type === 'CALLBACK' && candidate.nextReplyId?.toLowerCase() === targetReplyId,
      );
      if (button) return { kind: 'callback', workflow, button, reply };
    }
  }
  return null;
}

/**
 * Deterministic and side-effect free: first match wins. Cooldown is applied by
 * the caller to the returned workflow, so a cooled-down workflow suppresses the
 * reply instead of falling through to a lower-priority catch-all.
 */
export function matchWorkflow(
  workflows: readonly WorkflowView[],
  event: InboundEvent,
): MatchResult | null {
  return event.kind === 'message'
    ? matchMessage(workflows, event.text)
    : matchCallback(workflows, event.data);
}
