/**
 * CONTRACT-1 task 4: everything the live stream showed is persisted on the ChatMessage, so a reload
 * (GET /chat/threads/:id) restores it from the server: tool rows with redacted args/results, proposal
 * summaries with status, receipt lines with undo state, errors, and how the turn ended.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatThreadDetail, type ChatMessage, type ChatPart } from '@/contract';
import type { MockDataSource } from '@/server/datasource/mock';
import { ask, newDs, of } from './helpers';

let ds: MockDataSource;
beforeEach(() => {
  ds = newDs();
});
afterEach(() => ds.dispose());

async function reload(threadId = 'thread_today') {
  const detail = await ds.getChatThread({ params: { id: threadId } });
  expect(ChatThreadDetail.safeParse(detail).success).toBe(true);
  return detail;
}
const lastAssistant = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'assistant').at(-1)!;
const partsOf = <T extends ChatPart['type']>(m: ChatMessage, t: T) => m.parts.filter((p): p is Extract<ChatPart, { type: T }> => p.type === t);

describe('persisted chat detail', () => {
  it('tool rows keep name, summary, redacted args and result; the message records model + status', async () => {
    const evs = await ask(ds, 'move Globex prep after lunch and find the deck I made for them');
    const done = of(evs, 'done')[0];
    const m = lastAssistant((await reload()).messages);
    expect(m.id).toBe(done.messageId);
    expect(m).toMatchObject({ model: 'haiku', status: 'complete', route: { model: 'haiku' } }); // Assistant v2: Auto routes a lookup to Haiku
    const tools = partsOf(m, 'tool');
    expect(tools.map((t) => t.name)).toEqual(of(evs, 'tool-start').map((t) => t.name));
    expect(tools.every((t) => t.ok === true && typeof t.args === 'string' && typeof t.result === 'string')).toBe(true);
    const reschedule = tools.find((t) => t.name === 'items.reschedule')!;
    expect(JSON.parse(reschedule.args!)).toMatchObject({ startBy: expect.any(String) }); // structured args, as JSON text
    expect(reschedule.result).toBe('Rescheduled');
    expect(partsOf(m, 'resource').length).toBeGreaterThanOrEqual(2);
  });

  it('credential-like text in tool args and summaries is redacted before it is stored or streamed', async () => {
    const evs = await ask(ds, '/capture Rotate the demo creds, password: hunter2hunter2 ~5m');
    for (const t of of(evs, 'tool-start')) expect(t.summary).not.toContain('hunter2hunter2');
    const tool = partsOf(lastAssistant((await reload()).messages), 'tool')[0];
    expect(tool.summary).not.toContain('hunter2hunter2');
    expect(tool.args).not.toContain('hunter2hunter2');
    expect(tool.args).toContain('[REDACTED]'); // args = the redacted start summary (no structured args)
  });

  it('receipt lines carry undo state on reload: live → undone → redone', async () => {
    const evs = await ask(ds, 'move Globex prep after lunch and find the deck I made for them');
    const [start, note] = of(evs, 'receipt')[0].receipt.changes;
    const lines = async () => partsOf(lastAssistant((await reload()).messages), 'receipt')[0].receipt.changes;

    expect((await lines()).map((c) => [c.undoneAt, c.undoAuditId])).toEqual([[null, null], [null, null]]);

    const undo = await ds.undoAudit({ params: { id: start.auditId }, body: {} });
    const [s, n] = await lines();
    expect(s.undoneAt).toBeTruthy();
    expect(s.undoAuditId).toBe(undo.auditId);
    expect(n).toMatchObject({ auditId: note.auditId, undoneAt: null, undoAuditId: null });

    // redo = undo the undo: the line is live again; undoAuditId points at the redo (undo that to undo again)
    const redo = await ds.undoAudit({ params: { id: undo.auditId! }, body: {} });
    const [redone] = await lines();
    expect(redone.undoneAt).toBeNull();
    expect(redone.undoAuditId).toBe(redo.auditId);
    expect((await ds.getItem({ params: { id: start.entity.id } })).item.startBy).toBe(start.after);
  });

  it('proposal parts keep the summary and show the current status: pending → applied, or dismissed', async () => {
    const evs = await ask(ds, 'prioritize customer-facing over internal today');
    const sse = of(evs, 'proposal')[0];
    const part = () => reload().then((d) => partsOf(lastAssistant(d.messages), 'proposal')[0]);
    expect(await part()).toMatchObject({ summary: sse.summary, status: 'pending', proposal: { id: sse.id, status: 'pending' } });
    await ds.applyProposal({ params: { id: sse.id }, body: {} });
    expect(await part()).toMatchObject({ status: 'applied', proposal: { status: 'applied' } });

    const evs2 = await ask(ds, 'customer work matters more, change my policy');
    const p2 = of(evs2, 'proposal')[0];
    await ds.rejectProposal({ params: { id: p2.id }, body: {} });
    expect(await part()).toMatchObject({ status: 'dismissed', proposal: { id: p2.id, status: 'rejected' } });
  });

  it('an error turn persists an error part and status error', async () => {
    const evs = await ask(ds, '/error');
    const err = of(evs, 'error')[0].error;
    const m = lastAssistant((await reload()).messages);
    expect(m.status).toBe('error');
    expect(partsOf(m, 'error')[0].error).toEqual(err);
    expect(partsOf(m, 'tool')[0].ok).toBe(false);
  });

  it('an aborted turn, or a consumer that walks away, persists as stopped', async () => {
    const ac = new AbortController();
    for await (const ev of ds.chat({ body: { text: 'good morning', context: [] }, signal: ac.signal })) {
      if (ev.type === 'start') ac.abort();
    }
    expect(lastAssistant((await reload()).messages).status).toBe('stopped');

    for await (const ev of ds.chat({ body: { text: 'why is the ACME build first?', context: [] }, signal: new AbortController().signal })) {
      if (ev.type === 'tool-start') break; // the HTTP stream closed under us
    }
    const m = lastAssistant((await reload()).messages);
    expect(m.status).toBe('stopped');
    expect(partsOf(m, 'tool')).toHaveLength(1);
  });

  it('seeded messages without the new fields still validate and read back unchanged', async () => {
    const d = await reload();
    const seeded = d.messages.filter((m) => !m.status);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((m) => m.model === undefined)).toBe(true);
  });
});
