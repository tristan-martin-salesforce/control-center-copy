/**
 * Coordinator additions to CONTRACT-1:
 *  - LIB-compose fix: Slack mrkdwn "- " lines are literal text in the parse/preview path (Slack shows the
 *    hyphen); real bullet lists still serialize to "•" lines or rich_text blocks. Golden strings below.
 *  - One serializer: the mock's draft preview, dispatch payload and renditions come from src/lib/compose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftPreview, type Draft, type TipTapDoc } from '@/contract';
import { parseSlackMrkdwn, payloadFor, renderPreview, serializeSlackBlocks, serializeSlackMrkdwn } from '@/lib/compose';
import type { MockDataSource } from '@/server/datasource/mock';
import { newDs } from './helpers';

const SLACK = { kind: 'slack' as const, channelId: 'C1', format: 'mrkdwn' as const };
const text = (t: string) => ({ type: 'text', text: t });
const p = (...c: object[]) => ({ type: 'paragraph', content: c });
const li = (t: string) => ({ type: 'listItem', content: [p(text(t))] });
const doc = (...c: object[]) => ({ type: 'doc' as const, content: c }) as TipTapDoc;

describe('golden: Slack hyphens stay text, real lists stay lists', () => {
  const INPUT = 'Agenda for Thu:\n- scope\n- pricing\n\n• real bullet\n• second\n\n1. first\n2. second';

  it('parse', () => {
    expect(parseSlackMrkdwn(INPUT)).toEqual({
      type: 'doc',
      content: [
        p(text('Agenda for Thu:'), { type: 'hardBreak' }, text('- scope'), { type: 'hardBreak' }, text('- pricing')),
        { type: 'bulletList', content: [li('real bullet'), li('second')] },
        { type: 'orderedList', content: [li('first'), li('second')] },
      ],
    });
  });

  it('preview (what Slack shows)', () => {
    expect(renderPreview(parseSlackMrkdwn(INPUT), SLACK)).toBe(
      '<div class="cc-preview cc-preview-slack"><p>Agenda for Thu:<br>- scope<br>- pricing</p><ul><li>real bullet</li><li>second</li></ul><ol><li>first</li><li>second</li></ol></div>',
    );
    expect(renderPreview(doc(p(text('- not a list'))), SLACK)).toBe('<div class="cc-preview cc-preview-slack"><p>- not a list</p></div>');
  });

  it('round trip: parse → serialize gives the same mrkdwn back', () => {
    expect(serializeSlackMrkdwn(parseSlackMrkdwn(INPUT)).payload).toEqual({ text: INPUT });
  });

  it('serializing a real bulletList still emits • lines (mrkdwn) or a rich_text list (blocks)', () => {
    const list = doc({ type: 'bulletList', content: [li('a'), li('b')] });
    expect(serializeSlackMrkdwn(list).payload).toEqual({ text: '• a\n• b' });
    expect(serializeSlackBlocks(list).payload).toEqual({
      text: '• a\n• b',
      blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_list', style: 'bullet', indent: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'a' }] }, { type: 'rich_text_section', elements: [{ type: 'text', text: 'b' }] }] }] }],
    });
  });
});

describe('one serializer: mock preview = dispatch payload = src/lib/compose', () => {
  let ds: MockDataSource;
  beforeEach(() => {
    ds = newDs();
  });
  afterEach(() => ds.dispose());

  const slackDraft = () => ds.store.all('drafts').find((d) => d.destination.kind === 'slack')!;
  const emailDraft = () => ds.store.all('drafts').find((d) => d.destination.kind === 'email')!;

  async function previewAndDispatch(d: Draft) {
    const preview = DraftPreview.parse(await ds.previewDraft({ params: { id: d.id }, body: { mode: 'send' } }));
    const sent = await ds.dispatchDraft({ params: { id: d.id }, body: { ifVersion: d.version, mode: 'send', confirmToken: preview.confirmToken } });
    return { preview, sent };
  }

  it('Slack: payload text/blocks are payloadFor bytes; preview and dispatch are identical; html is renderPreview', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = slackDraft();
    const dest = d.destination as Extract<Draft['destination'], { kind: 'slack' }>;
    const compose = payloadFor(d.doc, { kind: 'slack', channelId: dest.channelId, ...(dest.threadTs ? { threadTs: dest.threadTs } : {}), format: 'auto' });
    const { preview, sent } = await previewAndDispatch(d);
    expect(preview.payload).toMatchObject({ api: 'chat.postMessage', channel: dest.channelId, ...compose });
    expect(JSON.stringify(sent.payload)).toBe(JSON.stringify(preview.payload));
    expect(sent.rendition).toEqual(preview.rendition);
    expect(preview.rendition.text).toBe(compose.text);
    expect(preview.html).toContain('cc-preview-slack');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('Slack: a doc with a list goes out as rich_text blocks (+ the mrkdwn rendition kept for older readers)', async () => {
    const d = slackDraft();
    const listDoc = doc(p(text('Plan:')), { type: 'bulletList', content: [li('scope'), li('pricing')] });
    const r = await ds.patchDraft({ params: { id: d.id }, body: { ifVersion: d.version, doc: listDoc } });
    expect(r.entity.rendered.slack_blocks?.format).toBe('slack_blocks');
    expect(r.entity.rendered.slack_mrkdwn?.text).toBe('Plan:\n\n• scope\n• pricing');
    const { preview } = await previewAndDispatch(r.entity);
    expect(preview.rendition.format).toBe('slack_blocks');
    expect(Array.isArray(preview.payload.blocks)).toBe(true);
    expect(preview.html).toContain('<ul');
  });

  it('Email: html/text are payloadFor bytes; preview and dispatch are identical', async () => {
    const d = emailDraft();
    const dest = d.destination as Extract<Draft['destination'], { kind: 'email' }>;
    const compose = payloadFor(d.doc, { kind: 'email', to: dest.to.map((a) => a.email), cc: dest.cc.map((a) => a.email), bcc: [], subject: dest.subject });
    const { preview, sent } = await previewAndDispatch(d);
    expect(preview.payload.html).toBe(compose.html);
    expect(preview.payload.text).toBe(compose.text);
    expect(preview.rendition).toMatchObject({ format: 'email_html', body: compose.html, text: compose.text });
    expect(JSON.stringify(sent.payload)).toBe(JSON.stringify(preview.payload));
    expect(preview.html).toContain(compose.html.slice(0, 40));
  });

  it('the confirm token binds the exact compose payload: an edit invalidates it', async () => {
    const d = slackDraft();
    const preview = await ds.previewDraft({ params: { id: d.id }, body: { mode: 'send' } });
    const r = await ds.patchDraft({ params: { id: d.id }, body: { ifVersion: d.version, doc: doc(p(text('changed'))) } });
    await expect(ds.dispatchDraft({ params: { id: d.id }, body: { ifVersion: r.entity.version, mode: 'send', confirmToken: preview.confirmToken } })).rejects.toMatchObject({ code: 'validation' });
  });
});
