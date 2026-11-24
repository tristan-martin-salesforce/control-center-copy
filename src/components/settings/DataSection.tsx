'use client';
/**
 * Settings ▸ Data ▸ Data & backups (01-ui-audit R8; p4-retention's policy, src/db/retention/policy.ts):
 *
 *   Retention   nightly clean-up on/off and how many days each kind of local record is kept (Save in the header)
 *   Run now     "Check what it would remove" (a dry run: counts per kind, nothing changes) → "Remove N records"
 *   Backups     where they go, when they run, how to restore
 *
 * Everything here is this Mac's own copy of your data (*Local data, privacy-safe logs*): nothing outside the app is
 * read or changed. The horizons live in user_settings `retention` (GET/PATCH /retention); a run is POST
 * /retention/run, forced so it works with the nightly clean-up off, and it waits while a scan runs.
 */
import { useEffect, useState } from 'react';
import type { RetentionRunPayload, RetentionSettings } from '@/contract';
import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { toast } from '@/client/toast';
import { copyText } from '@/components/time/shared';
import { STATE_FOLDER_DISPLAY } from '@/lib/state-folder-name';
import { Button, Skeleton } from '@/ui';
import { NumberInput, Switch } from './controls';
import { Block, Row, SaveActions, Section, useReportDirty } from './form';

export const BACKUP_DIR = `${STATE_FOLDER_DISPLAY}/backups/`;

type Days = Exclude<keyof RetentionSettings, 'enabled'>;

/** Each horizon in plain words (what it is, what goes, what stays). */
export const RETENTION_ROWS: Array<{ key: Days; label: string; help: string; min: number }> = [
  { key: 'llmTextDays', label: 'AI prompts and answers', help: 'The text sent to and from the model. The cost, model and timing stay; only the words go.', min: 1 },
  { key: 'traceDays', label: 'Scan step-by-step traces', help: 'The detailed trace of each scan. A short summary of each scan stays for 90 days.', min: 1 },
  { key: 'eventsDays', label: 'Resolved errors and notices', help: 'Problems that were fixed or acknowledged. Open ones always stay.', min: 1 },
  { key: 'orphanSourceDays', label: 'Messages nothing points at', help: 'Copies of Slack, Gmail and Drive items that no task, evidence or log entry uses.', min: 7 },
];

/** "Keeps 30 d of AI text · nightly" for the section nav. */
export function retentionSummary(r: RetentionSettings | undefined): string {
  if (!r) return '';
  return r.enabled ? `Nightly clean-up · AI text ${r.llmTextDays} d` : 'Nightly clean-up off';
}

/** Rows a run touched (or would), summed; null rules (delegated, not counted ahead) are left out. */
export function runTotal(r: RetentionRunPayload): number {
  return r.tables.reduce((n, t) => n + (t.rows ?? 0), 0);
}

const RULE_LABEL: Record<string, string> = {
  llm_text: 'AI prompts and answers',
  trace_full: 'Scan traces',
  events_resolved: 'Resolved errors and notices',
  orphan_sources: 'Unused message copies',
  priority_runs: 'Old ranking runs',
  scan_runs: 'Old scan records',
  jobs: 'Finished background jobs',
};

export const ruleLabel = (rule: string) => RULE_LABEL[rule] ?? rule.replace(/_/g, ' ');

export function fmtBytes(b: number): string {
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function RetentionBlock() {
  const q = useApi('getRetention');
  const save = useOptimisticMutation({ route: 'patchRetention', topics: ['settings'], toast: () => ({ title: 'Data retention saved' }) });
  const [draft, setDraft] = useState<RetentionSettings | null>(null);
  const saved = q.data;
  useEffect(() => {
    if (saved && !draft) setDraft(saved);
  }, [saved, draft]);
  const dirty = !!saved && !!draft && (Object.keys(saved) as Array<keyof RetentionSettings>).some((k) => saved[k] !== draft[k]);
  useReportDirty('data:Retention', 'Data retention', dirty);
  if (!saved || !draft) return <Skeleton variant="block" className="mt-6 h-40 w-full" />;
  const set = (patch: Partial<RetentionSettings>) => setDraft({ ...draft, ...patch });
  return (
    <Block
      id="data-retention"
      title="Keep"
      help="How long this Mac keeps each kind of record before the nightly clean-up removes it. Your tasks, hours, drafts and history are never removed."
      actions={<SaveActions dirty={dirty} onSave={() => void save.mutateAsync({ body: draft }).then((r) => setDraft(r)).catch(() => undefined)} onDiscard={() => setDraft(saved)} pending={save.isPending} testId="data-retention-save" />}
      feedback={save.error ? <p role="alert" className="text-body text-danger-700">Couldn’t save: {save.error.message}. Your changes are kept.</p> : null}
    >
      <Row label="Nightly clean-up" htmlFor="data-enabled" help={draft.enabled ? 'On: every night the app removes what is older than the days below. You can also run it now, below.' : 'Off: nothing is removed on its own. Run it now below whenever you like.'} edited={draft.enabled !== saved.enabled}>
        <Switch id="data-enabled" checked={draft.enabled} onChange={(enabled) => set({ enabled })} label="Nightly clean-up" testId="data-enabled" />
      </Row>
      {RETENTION_ROWS.map((r) => (
        <Row key={r.key} label={r.label} htmlFor={`data-${r.key}`} help={r.help} edited={draft[r.key] !== saved[r.key]}>
          <NumberInput id={`data-${r.key}`} value={draft[r.key]} onValue={(n) => set({ [r.key]: n } as Partial<RetentionSettings>)} min={r.min} width={88} data-testid={`data-${r.key}`} />
          <span className="text-body text-muted">days</span>
        </Row>
      ))}
    </Block>
  );
}

function RunNow() {
  const [plan, setPlan] = useState<RetentionRunPayload | null>(null);
  const [done, setDone] = useState<RetentionRunPayload | null>(null);
  const [busy, setBusy] = useState<'dry' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (dry: boolean) => {
    setBusy(dry ? 'dry' : 'run');
    setError(null);
    try {
      const r = await api('runRetention', { body: { dry } });
      if (dry) {
        setPlan(r);
        setDone(null);
      } else {
        setDone(r);
        setPlan(null);
        if (!r.skipped) toast({ title: `Removed ${runTotal(r)} old records`, body: `About ${fmtBytes(r.estimatedReclaimBytes)} freed once the database tidies up.` });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Nothing was removed.');
    } finally {
      setBusy(null);
    }
  };
  const shown = done ?? plan;
  const n = plan ? runTotal(plan) : 0;
  return (
    <Block id="data-run" title="Clean up now" help="Check first: it counts what would go and changes nothing. Then remove those records in one go.">
      <Row label="Run retention now" help="Uses the days above, even with the nightly clean-up off. It waits while a scan is running.">
        <Button variant="secondary" size="sm" loading={busy === 'dry'} disabled={!!busy} onClick={() => void run(true)} data-testid="data-run-dry">
          Check what it would remove
        </Button>
        {plan && !plan.skipped ? (
          <Button variant="primary" size="sm" loading={busy === 'run'} disabled={!!busy || n === 0} onClick={() => void run(false)} data-testid="data-run-now">
            {n === 0 ? 'Nothing to remove' : `Remove ${n} ${n === 1 ? 'record' : 'records'}`}
          </Button>
        ) : null}
      </Row>
      {error ? (
        <p role="alert" className="px-1 text-body text-danger-700">
          Couldn’t run the clean-up: {error}
        </p>
      ) : null}
      {shown ? <RunResult r={shown} /> : null}
    </Block>
  );
}

function RunResult({ r }: { r: RetentionRunPayload }) {
  if (r.skipped)
    return (
      <p role="status" className="px-1 text-body text-fg" data-testid="data-run-skipped">
        {r.skipped === 'scan_active' ? 'A scan is running, so nothing was removed. Try again when it finishes.' : 'The clean-up is off, so nothing was removed.'}
      </p>
    );
  return (
    <div role="status" className="grid gap-1 px-1" data-testid="data-run-result">
      <p className="text-body text-fg">
        {r.dry ? (
          <>
            Would remove <b className="font-bold">{runTotal(r)}</b> records, about {fmtBytes(r.estimatedReclaimBytes)}. Nothing has changed yet.
          </>
        ) : (
          <>
            Removed <b className="font-bold">{runTotal(r)}</b> records, about {fmtBytes(r.estimatedReclaimBytes)}.
          </>
        )}
      </p>
      <ul className="grid gap-0.5 text-caption text-muted">
        {r.tables.map((t) => (
          <li key={t.rule} className="flex gap-3">
            <span className="min-w-56">{ruleLabel(t.rule)}</span>
            <span className="tabular-nums text-fg">{t.rows === null ? 'counted when it runs' : t.rows}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Backups() {
  return (
    <Block id="data-backups" title="Backups and export">
      <Row label="Where" help="A full copy of your database, made every night at 02:30 (or on wake) and before every update. The newest 7 are kept.">
        <code className="rounded bg-surface-muted px-1.5 py-0.5 text-caption break-all text-fg" data-testid="data-backup-dir">
          {BACKUP_DIR}
        </code>
        <Button variant="quiet" size="sm" icon="copy" onClick={() => void copyText(BACKUP_DIR).then(() => toast({ title: 'Backup folder copied' }))}>
          Copy
        </Button>
      </Row>
      <Row label="Export" help="A backup file is the export: everything the app holds about your work, in one file you can keep or move to a new Mac.">
        <span className="text-body text-fg">Use the newest file in the backup folder</span>
      </Row>
      <Row label="Restore" help="Puts the newest backup into a new database so you can look at it first; nothing is replaced until you choose to.">
        <code className="rounded bg-surface-muted px-1.5 py-0.5 text-caption text-fg">npm run restore</code>
      </Row>
    </Block>
  );
}

export function DataSection() {
  return (
    <Section id="data" title="Data & backups" meta="What this Mac keeps, for how long, and where the backups are. Only the app’s own copy is touched; nothing in Slack, Gmail, Org62 or VDP changes.">
      <RetentionBlock />
      <RunNow />
      <Backups />
    </Section>
  );
}

/** The effect pane: what the clean-up never touches. */
export function DataEffect() {
  return (
    <div className="grid gap-3 p-4 text-body" data-testid="data-effect">
      <h3 className="text-body-lg font-bold text-fg-heading">What a clean-up never removes</h3>
      <ul className="grid list-disc gap-1.5 pl-5 text-fg">
        <li>Your tasks, drafts, hours and their history (Undo keeps working).</li>
        <li>Anything a task, evidence link or logged hour still points at.</li>
        <li>Open errors and notices.</li>
        <li>Anything outside this Mac: Slack, Gmail, Calendar, Drive, Org62 and VDP are never written.</li>
      </ul>
      <p className="text-muted">The database file shrinks after its nightly tidy-up, so the size you see in Health can lag a day behind.</p>
    </div>
  );
}
