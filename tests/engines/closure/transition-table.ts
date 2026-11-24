/**
 * The expected closure transition table: every state × signal (docs/reference/ENGINES.md §3 renders it).
 * Codes: `·` nothing (evidence attached) · `ctx` context only · `upd` fields only · `prop` proposal ·
 * `sib` sibling · `reopen` done/dismissed → open · `wake` snoozed → previous · else the target state
 * (`ip` in_progress, `woo` waiting_on_others, `wom` waiting_on_me, `ld` likely_done, `open`, `done`).
 */
export const COLUMNS = [
  'origin',
  'progress',
  'done_sure',
  'done_likely',
  'done_guess',
  'context',
  'contradiction',
  'requirement',
  'loop_back',
  'session_waiting',
  'session_running',
  'session_done',
  'session_failed',
  'drive_edit',
  'drive_partial',
  'drive_yes',
  'reply_me',
  'reply_them',
  'email_sent',
  'timer',
] as const;

//                                       origin prog  sure  likely guess ctx   contra  req     loop    s.wait s.run s.done s.fail d.edit d.part d.yes reply_me reply_them email timer
const T: Record<string, string> = {
  suggested: /*                     */ '·      ·     ·     ·      ·     ·     ·       ·       ·       ·      ·     ·      ·      ·      ·      ·     ·        ·          ·     ·',
  open: /*                          */ '·      ip    done  ld     ·     ·     ·       ·       ·       wom    ip    ld     ·      ip     ip     ld    done     ·          done  ·',
  'open (status locked)': /*        */ '·      prop  prop  prop   ·     ·     ·       ·       ·       prop   prop  prop   ·      prop   prop   prop  prop     ·          prop  ·',
  in_progress: /*                   */ '·      ·     done  ld     ·     ·     ·       ·       ·       wom    ·     ld     ·      ·      ·      ld    done     ·          done  ·',
  waiting_on_others: /*             */ '·      ·     done  ld     ·     ·     ·       ·       ·       wom    ·     ld     ·      ·      ·      ld    done     open       done  open',
  waiting_on_me: /*                 */ '·      ·     done  ld     ·     ·     ·       ·       ·       upd    ip    ld     ip     ·      ·      ld    done     ·          done  ·',
  likely_done: /*                   */ '·      ·     done  ·      ·     ·     ip      ip      ·       wom    ·     ·      ·      ·      ip     ·     done     ·          done  ·',
  'done (mine, 3d)': /*             */ '·      ·     ·     ·      ·     ·     reopen  reopen  reopen  ·      ·     ·      ·      ·      ·      ·     ·        ·          ·     ·',
  'done (mine, 20d)': /*            */ '·      ·     ·     ·      ·     ·     sib     sib     sib     ·      ·     ·      ·      ·      ·      ·     ·        ·          ·     ·',
  'done (handed off, 3d)': /*       */ 'ctx    ctx   ctx   ctx    ctx   ctx   ctx     ctx     reopen  ctx    ctx   ctx    ctx    ctx    ctx    ctx   ctx      ctx        ctx   ·',
  'done (handed off, 20d)': /*      */ 'ctx    ctx   ctx   ctx    ctx   ctx   ctx     ctx     sib     ctx    ctx   ctx    ctx    ctx    ctx    ctx   ctx      ctx        ctx   ·',
  snoozed: /*                       */ '·      ·     ·     ·      ·     ·     ·       ·       wake    ·      ·     ·      ·      ·      ·      ·     ·        ·          ·     wake',
  'dismissed (3d)': /*              */ '·      ·     ·     ·      ·     ·     ·       ·       reopen  ·      ·     ·      ·      ·      ·      ·     ·        ·          ·     ·',
  merged: /*                        */ '·      ·     ·     ·      ·     ·     ·       ·       ·       ·      ·     ·      ·      ·      ·      ·     ·        ·          ·     ·',
};

export const EXPECTED: Record<string, Record<(typeof COLUMNS)[number], string>> = Object.fromEntries(
  Object.entries(T).map(([row, line]) => {
    const codes = line.trim().split(/\s+/);
    if (codes.length !== COLUMNS.length) throw new Error(`row ${row}: ${codes.length} codes`);
    return [row, Object.fromEntries(COLUMNS.map((c, i) => [c, codes[i]!]))];
  }),
) as Record<string, Record<(typeof COLUMNS)[number], string>>;

const HEADER: Record<string, string> = {
  suggested: 'sug',
  open: 'open',
  'open (status locked)': 'open, locked',
  in_progress: 'ip',
  waiting_on_others: 'woo',
  waiting_on_me: 'wom',
  likely_done: 'ld',
  'done (mine, 3d)': 'done ≤N',
  'done (mine, 20d)': 'done >N',
  'done (handed off, 3d)': 'h/o ≤N',
  'done (handed off, 20d)': 'h/o >N',
  snoozed: 'snz',
  'dismissed (3d)': 'dis',
  merged: 'mrg',
};

/** Markdown: one row per signal, one column per state (ENGINES.md §3). */
export function renderTable(): string {
  const rows = Object.keys(T);
  const head = `| signal ↓ · state → | ${rows.map((r) => HEADER[r]).join(' | ')} |`;
  const sep = `|---|${rows.map(() => '---').join('|')}|`;
  const body = COLUMNS.map((c) => `| \`${c}\` | ${rows.map((r) => EXPECTED[r]![c]).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}
