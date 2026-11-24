import { describe, expect, it } from 'vitest';
import { classifyGoogleError, GoogleCallError } from '@/connectors/google/client';
import { GeminiNotesFetcher, notesDocMatchesEvent, parseGeminiNotes, parseNextSteps } from '@/connectors/google/gemini-notes';
import { clock, FakeGoogle, fx, ME, NOW, signal, WINDOW } from './helpers';

const notes = fx('gemini', 'notes.md');

describe('Next steps parsing', () => {
  const steps = parseNextSteps(notes, ME);

  it('parses every checklist item with assignee, title and description', () => {
    expect(steps).toHaveLength(4);
    expect(steps[1]).toMatchObject({ assignees: ['Pat Example'], title: 'Send the updated workshop deck', description: 'with the refreshed architecture slide.', done: false });
  });

  it('flags items assigned to me, including shared assignments', () => {
    expect(steps.filter((s) => s.isMine).map((s) => s.title)).toEqual(['Send the updated workshop deck', 'Draft the Private Connect answer']);
    expect(steps[2]!.assignees).toEqual(['Sam Planner', 'Pat Example']);
    expect(steps[0]!.isMine).toBe(false);
  });

  it('handles checked items and missing assignees', () => {
    const s = parseNextSteps('### Next steps\n\n- [x] [Pat Example] Done thing: all good\n- [ ] Unassigned thing\n', ME);
    expect(s[0]).toMatchObject({ done: true, isMine: true });
    expect(s[1]).toMatchObject({ assignees: [], title: 'Unassigned thing', isMine: false });
  });

  it('returns [] when there is no Next steps section', () => {
    expect(parseNextSteps('# Quick notes\n\n## Topic\n\n- a\n', ME)).toEqual([]);
  });

  it('matches me by first+last name or email, not by a bare first name collision', () => {
    const s = parseNextSteps('### Next steps\n\n- [ ] [Pat Other] x\n- [ ] [pat] y\n- [ ] [me@example.com] z\n', ME);
    expect(s.map((x) => x.isMine)).toEqual([false, false, true]);
  });

  it('R11: "## Suggested next steps" with "- [Name] …" (no checkbox) parses; so does "# Action items"', () => {
    const suggested = parseNextSteps('## Summary\n\nWe met.\n\n## Suggested next steps\n\n- [Pat Example] Send the pilot deck: by Friday\n- [Sam Planner] Book the workshop room\n', ME);
    expect(suggested.map((s) => [s.assignees, s.title, s.done, s.isMine])).toEqual([
      [['Pat Example'], 'Send the pilot deck', false, true],
      [['Sam Planner'], 'Book the workshop room', false, false],
    ]);
    const actions = parseNextSteps('# Action items\n\n- [ ] [Pat Example] Draft the SOW\n- [x] Shared thing\n', ME);
    expect(actions.map((s) => [s.title, s.done, s.isMine])).toEqual([
      ['Draft the SOW', false, true],
      ['Shared thing', true, false],
    ]);
    expect(parseGeminiNotes('## Summary\n\nWe met about the pilot.\n\n## Suggested next steps\n\n- [Pat Example] Send the pilot deck\n', ME).nextSteps).toHaveLength(1);
  });

  it('R11: a first-name assignee is me when it is unique among the attendees', () => {
    const md = '### Next steps\n\n- [ ] [Pat] Send the deck\n';
    expect(parseNextSteps(md, ME, { attendees: ['me@example.com', 'sam.planner@example.com'] })[0]!.isMine).toBe(true);
    expect(parseNextSteps(md, ME, { attendees: ['me@example.com', 'pat.other@example.com'] })[0]!.isMine).toBe(false);
    expect(parseNextSteps(md, ME)[0]!.isMine).toBe(false); // attendees unknown: no guess
  });

  it('parseGeminiNotes extracts summary, decisions and the transcript link', () => {
    const p = parseGeminiNotes(notes, ME);
    expect(p.hasNotes).toBe(true);
    expect(p.summary).toContain('workshop scope');
    expect(p.decisions).toHaveLength(2);
    expect(p.decisions[0]).toContain('Workshop scope');
    expect(p.transcriptUrl).toContain('/document/d/1GeminiNotesDocId0000000000000/');
    expect(p.nextSteps).toHaveLength(4);
  });
});

describe('notes doc matching', () => {
  it('matches Gemini-named docs to the event title', () => {
    expect(notesDocMatchesEvent('INT: ACME_CORP deal planning - 2026/03/10 08:00 PDT - Notes by Gemini', 'INT: ACME_CORP deal planning')).toBe(true);
    expect(notesDocMatchesEvent('Other meeting - 2026/03/10 08:00 PDT - Notes by Gemini', 'INT: ACME_CORP deal planning')).toBe(false);
    expect(notesDocMatchesEvent('INT: ACME_CORP deal planning - 2026/03/10 08:00 PDT - Recording', 'INT: ACME_CORP deal planning')).toBe(false);
  });
});

describe('GeminiNotesFetcher', () => {
  const route = (attached = true) => {
    const base = fx('calendar', 'events.txt').replace('  Meeting Link: https://meet.google.com/ppp-qqqq-rrr\n', '');
    const events = attached ? base : base.replace(/INT: ACME_CORP deal planning - 2026\/03\/10 08:00 PDT - Notes by Gemini/, 'Some attachment').replace('File ID: 1GeminiNotesDocId0000000000000', 'File ID: 1NotNotes');
    return new FakeGoogle({
      get_events: () => events,
      get_doc_as_markdown: () => notes,
      search_drive_files: () => fx('gemini', 'drive_search_notes.txt'),
    });
  };
  // Events that ended within the poll window are candidates; use a clock 20 min after the declined meeting ended.
  const at = new Date('2026-03-10T15:50:00.000Z');
  const win = { from: '2026-03-10T15:40:00.000Z', to: at.toISOString() };

  it('finds the notes doc attached to the event and emits one meeting_notes item with parsed next steps', async () => {
    const g = route(true);
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock: () => at });
    const r = await f.fetch('poll', null, win, { signal });
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(it).toMatchObject({ connector: 'gemini_notes', kind: 'meeting_notes', externalId: '1GeminiNotesDocId0000000000000', dedupeKey: 'gemini:1GeminiNotesDocId0000000000000', threadRef: 'calendar:evt_declined' });
    expect(it.payload).toMatchObject({ attendance: 'missed', missedMeeting: true, myResponse: 'declined' });
    expect((it.payload!.nextSteps as unknown[]).length).toBe(4);
    expect((it.payload!.myNextSteps as Array<{ title: string }>).map((s) => s.title)).toEqual(['Send the updated workshop deck', 'Draft the Private Connect answer']);
    expect(g.count('search_drive_files')).toBe(0); // attachment short-circuits the Drive search
  });

  it('falls back to a Drive name search when the event has no notes attachment', async () => {
    const g = route(false);
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock: () => at });
    const r = await f.fetch('poll', null, win, { signal });
    expect(g.count('search_drive_files')).toBe(1);
    expect(String(g.calls.find((c) => c.tool === 'search_drive_files')!.args.query)).toContain("name contains 'Notes by Gemini'");
    expect(r.items).toHaveLength(1);
  });

  it('GEM-1: a notes doc that is gone (404) is recorded and skipped; the run does not fail', async () => {
    const g = route(true);
    g.routes.get_doc_as_markdown = () => {
      const text = 'API error in get_doc_as_markdown: <HttpError 404 when requesting https://docs.googleapis.com/v1/documents/x returned "Requested entity was not found.">';
      throw new GoogleCallError('get_doc_as_markdown', classifyGoogleError(text), text);
    };
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock: () => at });
    const r = await f.fetch('poll', null, win, { signal });
    expect(r.items).toHaveLength(0);
    expect(r.coverage.find((c) => c.ref === '1GeminiNotesDocId0000000000000')?.meta).toMatchObject({ found: false, error: 'not_found' });
    // A connector failure is still a failure.
    g.routes.get_doc_as_markdown = () => {
      throw new GoogleCallError('get_doc_as_markdown', classifyGoogleError('invalid_grant'), 'invalid_grant');
    };
    await expect(f.fetch('poll', null, win, { signal })).rejects.toThrow(/auth/);
  });

  it('keeps polling (no item, coverage says not found) while the notes are not there yet', async () => {
    const g = route(false);
    g.routes.search_drive_files = () => 'Found 0 files for me@example.com matching x:\n';
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock: () => at });
    const r = await f.fetch('poll', null, win, { signal });
    expect(r.items).toHaveLength(0);
    const cov = r.coverage.find((c) => c.ref === 'notes-poll:evt_declined');
    expect(cov?.meta).toMatchObject({ found: false, polls: 1 });
    expect(JSON.parse(r.nextCursor.value).polls.evt_declined).toBe(1);
  });

  it('is idempotent once found, and re-emits if the notes are edited', async () => {
    const g = route(true);
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock: () => at });
    const r1 = await f.fetch('poll', null, win, { signal });
    const r2 = await f.fetch('poll', r1.nextCursor, win, { signal });
    expect(r2.items).toHaveLength(0);
    g.routes.get_doc_as_markdown = () => notes.replaceAll('- [ ] [Sam Planner] Book the demo org: for Wednesday.', '- [x] [Sam Planner] Book the demo org: for Wednesday.');
    const r3 = await f.fetch('poll', r2.nextCursor, win, { signal });
    expect(r3.items).toHaveLength(1);
    expect(r3.items[0]!.dedupeKey).toBe(r1.items[0]!.dedupeKey);
    expect(r3.items[0]!.contentHash).not.toBe(r1.items[0]!.contentHash);
  });

  it('GEM-2: a backfill window lists its own meetings, never from its start to now', async () => {
    const g = route(true);
    const later = new Date('2026-03-30T15:50:00.000Z'); // the first scan runs 20 days after this window
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock: () => later });
    const r = await f.fetch('poll', null, win, { signal });
    const call = g.calls.find((c) => c.tool === 'get_events')!;
    expect(call.args.time_max).toBe(win.to);
    expect(r.coverage[0]).toMatchObject({ ref: 'notes-poll', to: win.to });
    expect(r.items).toHaveLength(1); // the window's own meeting, read 20 days later
    // a poll's window ends now: unchanged
    const g2 = route(true);
    await new GeminiNotesFetcher({ google: g2, me: ME, clock: () => at }).fetch('poll', null, win, { signal });
    expect(g2.calls.find((c) => c.tool === 'get_events')!.args.time_max).toBe(at.toISOString());
  });

  it('attended meetings carry attendance too (no missed flag)', async () => {
    const g = route(true);
    g.routes.get_events = () => fx('calendar', 'events.txt').replace('me@example.com: declined', 'me@example.com: accepted');
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock: () => at });
    const r = await f.fetch('poll', null, win, { signal });
    expect(r.items[0]!.payload).toMatchObject({ attendance: 'attended', missedMeeting: false });
  });

  it('does not touch meetings that have not ended', async () => {
    const g = route(true);
    const f = new GeminiNotesFetcher({ google: g, me: ME, clock });
    const r = await f.fetch('poll', null, WINDOW, { signal });
    expect(r.items.every((i) => i.threadRef !== 'calendar:evt_future')).toBe(true);
    void NOW;
  });

  it('listForReconcile lists ended meetings that should have notes', async () => {
    const f = new GeminiNotesFetcher({ google: route(true), me: ME, clock });
    const l = await f.listForReconcile!('poll', { from: '2026-03-10T00:00:00.000Z', to: WINDOW.to }, { signal });
    expect(l.map((c) => c.ref)).toContain('notes-poll:evt_declined');
    expect(l.map((c) => c.ref)).not.toContain('notes-poll:evt_future');
  });
});
