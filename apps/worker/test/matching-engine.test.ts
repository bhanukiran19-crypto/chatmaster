import { describe, expect, it } from 'vitest';
import type { TelegramUpdate } from '@chatmaster/shared';
import {
  evaluationOrder,
  matchWorkflow,
  matchesTrigger,
  normalizeText,
  parseCommand,
  toInboundEvent,
  type InboundEvent,
  type WorkflowReplyView,
  type WorkflowTriggerView,
  type WorkflowView,
} from '../src/matching-engine/matcher.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const R_MAIN = '10000000-0000-4000-8000-000000000001';
const R_PRICING = '10000000-0000-4000-8000-000000000002';
const R_ORPHAN = '10000000-0000-4000-8000-000000000003';
const R_OTHER = '20000000-0000-4000-8000-000000000001';

let triggerSeq = 0;

function trigger(
  type: WorkflowTriggerView['type'],
  value: string | null = null,
  options: Partial<Pick<WorkflowTriggerView, 'caseInsensitive' | 'position'>> = {},
): WorkflowTriggerView {
  triggerSeq += 1;
  return {
    id: `tr-${String(triggerSeq)}`,
    type,
    value,
    caseInsensitive: options.caseInsensitive ?? true,
    position: options.position ?? 0,
  };
}

function reply(
  id: string,
  position: number,
  text: string,
  buttons: WorkflowReplyView['buttons'] = [],
): WorkflowReplyView {
  return { id, position, text, parseMode: 'NONE', buttons };
}

function workflow(id: string, partial: Partial<WorkflowView> = {}): WorkflowView {
  return {
    id,
    enabled: true,
    priority: 100,
    cooldownSeconds: 0,
    triggers: [],
    replies: [reply(`${id}-primary`, 0, `reply from ${id}`)],
    ...partial,
  };
}

function text(value: string, chatId: string | number = 12345): InboundEvent {
  const event = toInboundEvent({
    update_id: 1,
    message: {
      message_id: 100,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private' },
      text: value,
    },
  });
  if (!event) throw new Error('fixture produced no event');
  return event;
}

function callback(data: string | undefined): InboundEvent {
  return {
    kind: 'callback',
    chatId: '12345',
    callbackQueryId: 'cbq-1',
    data,
    messageId: 55,
  };
}

/** Menu workflow: primary reply has a "Pricing" CALLBACK button chaining to R_PRICING. */
function menuWorkflow(partial: Partial<WorkflowView> = {}): WorkflowView {
  return workflow('wf-menu', {
    triggers: [trigger('START')],
    replies: [
      reply(R_MAIN, 0, 'Main menu', [
        {
          id: 'btn-pricing',
          row: 0,
          column: 0,
          type: 'CALLBACK',
          label: 'Pricing',
          url: null,
          nextReplyId: R_PRICING,
        },
        {
          id: 'btn-site',
          row: 0,
          column: 1,
          type: 'URL',
          label: 'Site',
          url: 'https://example.com',
          nextReplyId: null,
        },
      ]),
      reply(R_PRICING, 1, 'Pricing details'),
      // Present in the workflow but no button links to it.
      reply(R_ORPHAN, 2, 'Internal draft'),
    ],
    ...partial,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Event extraction
// ────────────────────────────────────────────────────────────────────────────

describe('toInboundEvent', () => {
  it('extracts chat, text and message id from a message', () => {
    expect(text('hello', -100123)).toEqual({
      kind: 'message',
      chatId: '-100123',
      text: 'hello',
      messageId: 100,
    });
  });

  it('treats non-text messages as empty text', () => {
    const event = toInboundEvent({
      update_id: 2,
      message: { message_id: 1, date: 1, chat: { id: 1, type: 'private' }, caption: 'photo' },
    });
    expect(event).toMatchObject({ kind: 'message', text: '' });
  });

  it('extracts callback queries, falling back to the sender chat for inline messages', () => {
    const from = { id: 777, is_bot: false, first_name: 'A' };
    const withMessage: TelegramUpdate = {
      update_id: 3,
      callback_query: {
        id: 'q1',
        from,
        data: 'r:x',
        message: { message_id: 9, date: 1, chat: { id: 42, type: 'private' } },
      },
    };
    expect(toInboundEvent(withMessage)).toEqual({
      kind: 'callback',
      chatId: '42',
      callbackQueryId: 'q1',
      data: 'r:x',
      messageId: 9,
    });

    const inline: TelegramUpdate = {
      update_id: 4,
      callback_query: { id: 'q2', from, data: 'r:x' },
    };
    expect(toInboundEvent(inline)).toMatchObject({ chatId: '777', messageId: undefined });
  });

  it('returns null for updates without a message or callback query', () => {
    expect(toInboundEvent({ update_id: 5 })).toBeNull();
  });
});

describe('parseCommand', () => {
  it.each([
    ['/help', 'help'],
    ['/help args here', 'help'],
    ['/help@MyBot', 'help'],
    ['/help@MyBot args', 'help'],
    ['/Start', 'Start'],
  ])('parses %j as %j', (input, expected) => {
    expect(parseCommand(input)).toBe(expected);
  });

  it.each(['help', ' /help', '/help-me', '/', '//help', '/héllo', `/${'a'.repeat(33)}`])(
    'rejects %j',
    (input) => {
      expect(parseCommand(input)).toBeNull();
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Trigger types
// ────────────────────────────────────────────────────────────────────────────

describe('trigger types', () => {
  it('EXACT matches the whole message, ignoring surrounding whitespace', () => {
    const t = trigger('EXACT', 'pricing');
    expect(matchesTrigger(t, 'pricing')).toBe(true);
    expect(matchesTrigger(t, '  pricing \n')).toBe(true);
    expect(matchesTrigger(t, 'pricing please')).toBe(false);
    expect(matchesTrigger(t, 'pric')).toBe(false);
  });

  it('EXACT trims the configured value as well', () => {
    expect(matchesTrigger(trigger('EXACT', '  pricing  '), 'pricing')).toBe(true);
  });

  it('CONTAINS matches a substring anywhere', () => {
    const t = trigger('CONTAINS', 'refund');
    expect(matchesTrigger(t, 'I want a refund now')).toBe(true);
    expect(matchesTrigger(t, 'refund')).toBe(true);
    expect(matchesTrigger(t, 'refunds?')).toBe(true);
    expect(matchesTrigger(t, 'ref und')).toBe(false);
  });

  it('COMMAND matches the command name with or without a configured slash and bot suffix', () => {
    for (const value of ['help', '/help']) {
      const t = trigger('COMMAND', value);
      expect(matchesTrigger(t, '/help')).toBe(true);
      expect(matchesTrigger(t, '/help@MyBot extra')).toBe(true);
      expect(matchesTrigger(t, '/helpme')).toBe(false);
      expect(matchesTrigger(t, 'help')).toBe(false);
      expect(matchesTrigger(t, 'please /help')).toBe(false);
    }
  });

  it('START matches /start with payloads and bot suffix, nothing else', () => {
    const t = trigger('START');
    expect(matchesTrigger(t, '/start')).toBe(true);
    expect(matchesTrigger(t, '/start ref_abc')).toBe(true);
    expect(matchesTrigger(t, '/start@MyBot')).toBe(true);
    expect(matchesTrigger(t, '/started')).toBe(false);
    expect(matchesTrigger(t, 'start')).toBe(false);
  });

  it('ANY matches any non-blank text', () => {
    const t = trigger('ANY');
    expect(matchesTrigger(t, 'x')).toBe(true);
    expect(matchesTrigger(t, '/whatever')).toBe(true);
    expect(matchesTrigger(t, '')).toBe(false);
    expect(matchesTrigger(t, '   ')).toBe(false);
  });

  it('valued triggers with a missing or blank value never match', () => {
    for (const type of ['EXACT', 'CONTAINS', 'COMMAND'] as const) {
      expect(matchesTrigger(trigger(type, null), 'anything')).toBe(false);
      expect(matchesTrigger(trigger(type, '   '), 'anything')).toBe(false);
    }
  });

  it('blank messages never match a valued trigger', () => {
    expect(matchesTrigger(trigger('CONTAINS', ' '), '   ')).toBe(false);
    expect(matchesTrigger(trigger('EXACT', 'a'), '')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Case sensitivity
// ────────────────────────────────────────────────────────────────────────────

describe('case sensitivity', () => {
  it.each([
    ['EXACT', 'Pricing Info', 'pricing INFO'],
    ['CONTAINS', 'Refund', 'need a REFUND'],
    ['COMMAND', 'Help', '/HELP'],
  ] as const)('%s is case-insensitive by default', (type, value, message) => {
    expect(matchesTrigger(trigger(type, value), message)).toBe(true);
  });

  it.each([
    ['EXACT', 'Pricing Info', 'pricing INFO', 'Pricing Info'],
    ['CONTAINS', 'Refund', 'need a REFUND', 'need a Refund'],
    ['COMMAND', 'Help', '/help', '/Help'],
  ] as const)('%s honours caseInsensitive: false', (type, value, wrongCase, exactCase) => {
    const t = trigger(type, value, { caseInsensitive: false });
    expect(matchesTrigger(t, wrongCase)).toBe(false);
    expect(matchesTrigger(t, exactCase)).toBe(true);
  });

  it('START is always case-insensitive (Telegram clients may capitalise it)', () => {
    expect(matchesTrigger(trigger('START', null, { caseInsensitive: false }), '/START')).toBe(true);
  });

  it('folds non-ASCII letters when case-insensitive', () => {
    expect(matchesTrigger(trigger('EXACT', 'ÉCOLE'), 'école')).toBe(true);
    // Lower-casing, not full case folding: ß does not expand to "ss".
    expect(matchesTrigger(trigger('EXACT', 'straße'), 'STRASSE')).toBe(false);
    expect(matchesTrigger(trigger('CONTAINS', 'ПРИВЕТ'), 'ну привет всем')).toBe(true);
    expect(matchesTrigger(trigger('EXACT', 'ÉCOLE', { caseInsensitive: false }), 'école')).toBe(
      false,
    );
  });

  it('treats composed and decomposed Unicode forms as equal in both modes', () => {
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    expect(composed).not.toBe(decomposed);
    expect(matchesTrigger(trigger('EXACT', composed, { caseInsensitive: false }), decomposed)).toBe(
      true,
    );
    expect(
      matchesTrigger(trigger('CONTAINS', decomposed), `un ${composed.toUpperCase()} noir`),
    ).toBe(true);
  });

  it('normalizeText only lower-cases when asked', () => {
    expect(normalizeText('AbC', true)).toBe('abc');
    expect(normalizeText('AbC', false)).toBe('AbC');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Priority and determinism
// ────────────────────────────────────────────────────────────────────────────

describe('priority ordering', () => {
  const greet = (id: string, priority: number) =>
    workflow(id, { priority, triggers: [trigger('CONTAINS', 'hi')] });

  it('lower priority number wins when several workflows match', () => {
    const match = matchWorkflow(
      [greet('wf-late', 50), greet('wf-early', 10), greet('wf-mid', 20)],
      text('hi'),
    );
    expect(match?.workflow.id).toBe('wf-early');
  });

  it('result does not depend on input array order', () => {
    const a = greet('wf-a', 10);
    const b = greet('wf-b', 20);
    expect(matchWorkflow([a, b], text('hi'))?.workflow.id).toBe('wf-a');
    expect(matchWorkflow([b, a], text('hi'))?.workflow.id).toBe('wf-a');
  });

  it('breaks priority ties deterministically by id', () => {
    const x = greet('wf-x', 10);
    const y = greet('wf-y', 10);
    expect(matchWorkflow([y, x], text('hi'))?.workflow.id).toBe('wf-x');
    expect(matchWorkflow([x, y], text('hi'))?.workflow.id).toBe('wf-x');
  });

  it('falls through a higher-priority workflow whose triggers do not match', () => {
    const specific = workflow('wf-pricing', {
      priority: 1,
      triggers: [trigger('EXACT', 'pricing')],
    });
    const fallback = workflow('wf-fallback', { priority: 999, triggers: [trigger('ANY')] });
    expect(matchWorkflow([specific, fallback], text('hello'))?.workflow.id).toBe('wf-fallback');
    expect(matchWorkflow([specific, fallback], text('pricing'))?.workflow.id).toBe('wf-pricing');
  });

  it('evaluates triggers by position and reports the first that matches', () => {
    const late = trigger('ANY', null, { position: 5 });
    const early = trigger('CONTAINS', 'hi', { position: 1 });
    const match = matchWorkflow([workflow('wf', { triggers: [late, early] })], text('hi there'));
    expect(match).toMatchObject({ kind: 'trigger', trigger: { id: early.id } });
  });

  it('always sends the position-0 reply on a trigger match', () => {
    const wf = workflow('wf', {
      triggers: [trigger('ANY')],
      replies: [reply('second', 1, 'second'), reply('primary', 0, 'primary')],
    });
    expect(matchWorkflow([wf], text('x'))?.reply.id).toBe('primary');
  });

  it('evaluationOrder drops disabled workflows and sorts the rest', () => {
    const order = evaluationOrder([
      workflow('c', { priority: 3 }),
      workflow('a', { priority: 1, enabled: false }),
      workflow('b', { priority: 2 }),
    ]);
    expect(order.map((wf) => wf.id)).toEqual(['b', 'c']);
  });

  it('does not mutate the caller array', () => {
    const list = [greet('wf-b', 20), greet('wf-a', 10)];
    matchWorkflow(list, text('hi'));
    expect(list.map((wf) => wf.id)).toEqual(['wf-b', 'wf-a']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// No match
// ────────────────────────────────────────────────────────────────────────────

describe('no match', () => {
  it('returns null when there are no workflows', () => {
    expect(matchWorkflow([], text('hello'))).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const wf = workflow('wf', {
      triggers: [trigger('EXACT', 'pricing'), trigger('COMMAND', 'help')],
    });
    expect(matchWorkflow([wf], text('what is this'))).toBeNull();
  });

  it('returns null for a workflow without triggers', () => {
    expect(matchWorkflow([workflow('wf')], text('anything'))).toBeNull();
  });

  it('skips a matching workflow that has no primary reply and tries the next one', () => {
    const broken = workflow('wf-broken', {
      priority: 1,
      triggers: [trigger('ANY')],
      replies: [reply('only-secondary', 1, 'secondary')],
    });
    const healthy = workflow('wf-ok', { priority: 2, triggers: [trigger('ANY')] });
    expect(matchWorkflow([broken], text('x'))).toBeNull();
    expect(matchWorkflow([broken, healthy], text('x'))?.workflow.id).toBe('wf-ok');
  });

  it('non-text messages do not match even an ANY trigger', () => {
    expect(matchWorkflow([workflow('wf', { triggers: [trigger('ANY')] })], text(''))).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Disabled workflows
// ────────────────────────────────────────────────────────────────────────────

describe('disabled workflows', () => {
  it('never match, even with the best priority and a matching trigger', () => {
    const wf = workflow('wf', { enabled: false, priority: 0, triggers: [trigger('ANY')] });
    expect(matchWorkflow([wf], text('hello'))).toBeNull();
  });

  it('are skipped in favour of the next enabled workflow', () => {
    const disabled = workflow('wf-off', {
      enabled: false,
      priority: 1,
      triggers: [trigger('ANY')],
    });
    const enabled = workflow('wf-on', { priority: 50, triggers: [trigger('ANY')] });
    expect(matchWorkflow([disabled, enabled], text('hello'))?.workflow.id).toBe('wf-on');
  });

  it('do not serve button presses for their replies', () => {
    expect(
      matchWorkflow([menuWorkflow({ enabled: false })], callback(`r:${R_PRICING}`)),
    ).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Inline buttons (callback_query)
// ────────────────────────────────────────────────────────────────────────────

describe('callback_query matching', () => {
  it('resolves a button press to the linked reply and the button that links it', () => {
    const match = matchWorkflow([menuWorkflow()], callback(`r:${R_PRICING}`));
    expect(match).toMatchObject({
      kind: 'callback',
      workflow: { id: 'wf-menu' },
      button: { id: 'btn-pricing' },
      reply: { id: R_PRICING, text: 'Pricing details' },
    });
  });

  it('accepts the legacy reply: prefix and upper-case UUIDs', () => {
    expect(matchWorkflow([menuWorkflow()], callback(`reply:${R_PRICING}`))?.reply.id).toBe(
      R_PRICING,
    );
    expect(
      matchWorkflow([menuWorkflow()], callback(`r:${R_PRICING.toUpperCase()}`))?.reply.id,
    ).toBe(R_PRICING);
  });

  it('rejects forged payloads pointing at a reply no button links to', () => {
    expect(matchWorkflow([menuWorkflow()], callback(`r:${R_ORPHAN}`))).toBeNull();
    // The primary reply is not linked by any button either.
    expect(matchWorkflow([menuWorkflow()], callback(`r:${R_MAIN}`))).toBeNull();
  });

  it('rejects references to replies outside the loaded (connection-scoped) workflows', () => {
    expect(matchWorkflow([menuWorkflow()], callback(`r:${R_OTHER}`))).toBeNull();
  });

  it.each([
    undefined,
    '',
    'Pricing',
    'r:',
    'r:not-a-uuid',
    `x:${R_PRICING}`,
    `r:${R_PRICING}extra`,
    'r:'.padEnd(70, 'a'),
  ])('ignores malformed callback data %j', (data) => {
    expect(matchWorkflow([menuWorkflow()], callback(data))).toBeNull();
  });

  it('does not evaluate text triggers against callback data', () => {
    const catchAll = workflow('wf-any', {
      priority: 0,
      triggers: [trigger('ANY'), trigger('CONTAINS', 'Pricing')],
    });
    expect(matchWorkflow([catchAll], callback('Pricing'))).toBeNull();
  });

  it('URL buttons cannot be used to reach a reply', () => {
    const wf = workflow('wf', {
      replies: [
        reply('10000000-0000-4000-8000-0000000000aa', 0, 'p', [
          {
            id: 'b',
            row: 0,
            column: 0,
            type: 'URL',
            label: 'x',
            url: 'https://x.y',
            nextReplyId: R_PRICING,
          },
        ]),
        reply(R_PRICING, 1, 'target'),
      ],
    });
    expect(matchWorkflow([wf], callback(`r:${R_PRICING}`))).toBeNull();
  });

  it('message events never resolve through button links', () => {
    expect(matchWorkflow([menuWorkflow({ triggers: [] })], text(`r:${R_PRICING}`))).toBeNull();
  });
});
