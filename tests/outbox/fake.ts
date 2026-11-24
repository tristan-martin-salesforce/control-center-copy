/**
 * BE-OUTBOX test doubles. Every outbox test talks to this fake MCP transport: nothing here opens a socket,
 * file or process, and no real write tool is ever called.
 */
import type { OutboxTransport, ToolCall, ToolResult } from '../../src/outbox';

export type Handler = (call: ToolCall) => ToolResult | Promise<ToolResult>;

/** Records every call; answers from per-tool handlers (default: a plausible success for each outbox tool). */
export class FakeMcp implements OutboxTransport {
  readonly calls: ToolCall[] = [];
  private handlers = new Map<string, Handler>();
  /** What the fake "destination" holds, for read-back. */
  readonly posted: Array<{ tool: string; id: string; args: Record<string, unknown> }> = [];
  private n = 0;

  on(tool: string, h: Handler): this {
    this.handlers.set(tool, h);
    return this;
  }

  /** Make the next call to `tool` return an MCP error with this text, then fall back to the default. */
  failOnce(tool: string, text: string): this {
    const prev = this.handlers.get(tool);
    this.handlers.set(tool, () => {
      if (prev) this.handlers.set(tool, prev);
      else this.handlers.delete(tool);
      return { isError: true, text };
    });
    return this;
  }

  writes(): ToolCall[] {
    return this.calls.filter((c) => ['slack_send_message', 'slack_send_message_draft', 'send_gmail_message', 'draft_gmail_message'].includes(c.tool));
  }

  async callTool(call: ToolCall): Promise<ToolResult> {
    this.calls.push(structuredClone(call));
    const h = this.handlers.get(call.tool);
    if (h) return h(call);
    return this.defaultFor(call);
  }

  private defaultFor(call: ToolCall): ToolResult {
    const a = call.args;
    switch (call.tool) {
      case 'slack_send_message': {
        const ts = `1730800000.${String(100001 + this.n++)}`;
        this.posted.push({ tool: call.tool, id: ts, args: a });
        return { text: JSON.stringify({ ok: true, ts, permalink: `https://fake.slack.com/archives/${String(a.channel_id)}/p${ts.replace('.', '')}` }) };
      }
      case 'slack_send_message_draft':
        this.posted.push({ tool: call.tool, id: `draft${this.n++}`, args: a });
        return { text: JSON.stringify({ ok: true, channel_link: `https://app.slack.com/client/TFAKE/${String(a.channel_id)}` }) };
      case 'slack_read_thread': {
        const hit = this.posted.find((p) => p.tool === 'slack_send_message' && (p.id === a.message_ts || p.id === a.oldest));
        return hit ? { text: `Message_ts: ${hit.id}\nText: ${String(hit.args.message)}` } : { isError: true, text: 'thread_not_found' };
      }
      case 'send_gmail_message': {
        const id = `msg${String(this.n++).padStart(6, '0')}`;
        this.posted.push({ tool: call.tool, id, args: a });
        return { text: `Email sent! Message ID: ${id}` };
      }
      case 'draft_gmail_message': {
        const id = `msg${String(this.n++).padStart(6, '0')}`;
        this.posted.push({ tool: call.tool, id, args: a });
        return { text: `Draft created! Draft ID: r-${id}` };
      }
      case 'get_gmail_message_content': {
        const hit = this.posted.find((p) => p.id === a.message_id);
        return hit ? { text: `Subject: ${String(hit.args.subject)}\n\n${String(hit.args.body)}` } : { isError: true, text: 'Requested entity was not found.' };
      }
      case 'search_gmail_messages': {
        const hits = this.posted.filter((p) => p.tool === 'draft_gmail_message');
        return { text: hits.length ? hits.map((h) => `Message ID: ${h.id}`).join('\n') : 'No messages found' };
      }
      default:
        return { isError: true, text: `fake: no such tool ${call.tool}` };
    }
  }
}
