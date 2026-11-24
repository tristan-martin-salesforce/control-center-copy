/**
 * BE-OUTBOX · adapter mapping: `payloadFor()` payload → the exact MCP tool call, and tool text → ids.
 * Pure functions; nothing is called.
 */
import { describe, expect, it } from 'vitest';

import type { Destination, TipTapDoc } from '../../src/contract';
import { adapterFor, mrkdwnToMarkdown } from '../../src/outbox';
import { slackTsFrom } from '../../src/outbox/adapters/slack';
import { payloadFor } from '../../src/server/datasource/mock/render';

const p = (...content: TipTapDoc['content']): TipTapDoc => ({ type: 'doc', content });
const text = (t: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });

describe('Slack adapter', () => {
  const dest: Destination = { kind: 'slack', target: 'thread', channelId: 'C0ACME', channelName: '#acme-ext', threadTs: '1730700000.000100' };
  const doc = p(
    { type: 'paragraph', content: [text('Hi '), text('Dana', [{ type: 'bold' }]), text(', see '), text('the plan', [{ type: 'link', attrs: { href: 'https://example.com/plan' } }]), text(' & reply.')] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [text('two', [{ type: 'strike' }])] }] }] },
  );

  it('maps the payload to slack_send_message / slack_send_message_draft with markdown text and the thread', () => {
    const payload = payloadFor(dest, doc, 'send');
    const call = adapterFor('slack').toolCall(payload, 'send');
    expect(call.server).toBe('slack');
    expect(call.tool).toBe('slack_send_message');
    expect(call.args).toEqual({ channel_id: 'C0ACME', thread_ts: '1730700000.000100', message: mrkdwnToMarkdown(String(payload.text)) });
    expect(call.args.message).toContain('**Dana**');
    expect(call.args.message).toContain('[the plan](https://example.com/plan)');
    expect(call.args.message).toContain('& reply.');
    expect(call.args.message).toMatch(/^- one$/m);
    expect(call.args.message).toMatch(/^- ~~two~~$/m);
    expect(adapterFor('slack').toolCall(payloadFor(dest, doc, 'draft'), 'draft').tool).toBe('slack_send_message_draft');
  });

  it('mrkdwn → markdown keeps code, mentions and plain asterisks intact', () => {
    expect(mrkdwnToMarkdown('ping <@U123> in <#C9|general> `*not bold*` and 2*3*4')).toBe('ping <@U123> in <#C9|general> `*not bold*` and 2*3*4');
    expect(mrkdwnToMarkdown('```\nconst a = 1 &lt; 2;\n```')).toBe('```\nconst a = 1 < 2;\n```');
    expect(mrkdwnToMarkdown('_italic_ and *bold* and ~gone~')).toBe('_italic_ and **bold** and ~~gone~~');
    expect(mrkdwnToMarkdown('<https://x.test>')).toBe('https://x.test');
  });

  it('parses the ts from a result or permalink, and the channel link for a draft', () => {
    expect(slackTsFrom('{"ok":true,"ts":"1730812345.123456"}')).toBe('1730812345.123456');
    expect(slackTsFrom('Posted: https://acme.slack.com/archives/C0ACME/p1730812345123456')).toBe('1730812345.123456');
    expect(slackTsFrom('ok')).toBeNull();
    expect(adapterFor('slack').parseWrite({ text: '{"channel_link":"https://app.slack.com/client/T1/C0ACME"}' }, 'draft')).toEqual({ externalId: null, link: 'https://app.slack.com/client/T1/C0ACME' });
  });

  it('refuses a payload without a channel or text', () => {
    expect(() => adapterFor('slack').toolCall({ text: 'hi' }, 'send')).toThrow(/no channel/);
    expect(() => adapterFor('slack').toolCall({ channel: 'C1' }, 'send')).toThrow(/no text/);
  });
});

describe('Gmail adapter', () => {
  const dest: Destination = {
    kind: 'email',
    target: 'reply_all',
    to: [{ name: 'Pat Example', email: 'pat@example.com' }, { email: 'sam@example.com' }],
    cc: [{ email: 'lee@example.com' }],
    subject: 'Re: Revised SOW pricing',
    threadId: 'thr_123',
    inReplyTo: '<m1@example.com>',
  };
  const doc = p({ type: 'paragraph', content: [text('Thanks, attached the revised numbers.')] });

  it('send → send_gmail_message with the compose HTML (no signature added), recipients, thread and reply headers', () => {
    const payload = payloadFor(dest, doc, 'send');
    const call = adapterFor('gmail').toolCall(payload, 'send');
    expect(call).toEqual({
      server: 'mcp-adaptor',
      tool: 'send_gmail_message',
      args: {
        to: 'Pat Example <pat@example.com>, sam@example.com',
        cc: 'lee@example.com',
        subject: 'Re: Revised SOW pricing',
        body: payload.html,
        body_format: 'html',
        thread_id: 'thr_123',
        in_reply_to: '<m1@example.com>',
        references: '<m1@example.com>',
      },
    });
  });

  it('draft → draft_gmail_message with include_signature: false (what was previewed is what lands)', () => {
    const call = adapterFor('gmail').toolCall(payloadFor(dest, doc, 'draft'), 'draft');
    expect(call.tool).toBe('draft_gmail_message');
    expect(call.args.include_signature).toBe(false);
  });

  it('send without a recipient is refused; a draft may have none', () => {
    const none: Destination = { ...dest, to: [{ email: 'x@example.com' }] };
    const payload = { ...payloadFor(none, doc, 'send'), to: [] };
    expect(() => adapterFor('gmail').toolCall(payload, 'send')).toThrow(/no recipient/);
    expect(adapterFor('gmail').toolCall(payload, 'draft').args.to).toBeUndefined();
  });

  it('parses message and draft ids from the tool text', () => {
    expect(adapterFor('gmail').parseWrite({ text: 'Email sent! Message ID: 18c2f0aa' }, 'send').externalId).toBe('18c2f0aa');
    expect(adapterFor('gmail').parseWrite({ text: 'Draft created! Draft ID: r-5531 (message id 18c2)' }, 'draft').externalId).toBe('r-5531');
  });
});
