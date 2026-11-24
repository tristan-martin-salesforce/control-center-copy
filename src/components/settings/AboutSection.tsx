'use client';
/**
 * Settings ▸ About (D-57): which build this is (version, sha, build time), the database migration, the persona and
 * the worker's version, where the changelog lives and how to update. Also brings the guide back: the Getting
 * started checklist and the first-visit tips. Read-only apart from the guide buttons (instant).
 */
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { copyText } from '@/components/time/shared';
import { openReadme } from '@/guide/Readme';
import { ALL_MARK_IDS } from '@/guide/pages';
import { useGuideSettings } from '@/guide/useGuide';
import { versionLabel, versionWarning } from '@/lib/version-line';
import { Button, Skeleton, useTimeZone } from '@/ui';
import { fmtClock, fmtDay } from '@/ui/format';
import { Glyph } from './controls';
import { Block, Instant, Row, Section } from './form';
import s from './settings.module.css';

const Loading = () => <Skeleton variant="block" className="mt-6 h-48 w-full" />;

/** One paste-able line for a bug report or a "which version are you on?" thread. */
export function versionReport(v: { version: string; sha: string | null; builtAt: string | null; migration: string | null; workerVersion: string | null; persona: { id: string; level: string }; dirty?: number }): string {
  return [`Command Center v${v.version}`, v.sha ? `(${v.sha}${(v.dirty ?? 0) > 0 ? ', modified' : ''})` : (v.dirty ?? 0) > 0 ? '(modified)' : null, v.builtAt ? `built ${v.builtAt.slice(0, 16).replace('T', ' ')}Z` : null, `· migration ${v.migration ?? 'none'}`, `· worker ${v.workerVersion ? `v${v.workerVersion}` : 'not running'}`, `· persona ${v.persona.id}/${v.persona.level}`]
    .filter(Boolean)
    .join(' ');
}

export function aboutSummary(v: { version: string; sha: string | null } | undefined): string {
  return v ? versionLabel(v) : '';
}

export function AboutSection() {
  const q = useApi('getVersion', undefined, { staleTime: 30_000 });
  const guide = useGuideSettings();
  const tz = useTimeZone();
  const v = q.data;
  const warn = v ? versionWarning(v) : null;
  const seenTips = guide.guide ? ALL_MARK_IDS.filter((id) => guide.guide!.seen[id]).length : 0;
  return (
    <Section id="about" title="About" meta="Which build you are running, and how updates reach you. Quote the version line when you report a bug.">
      {!v ? (
        <Loading />
      ) : (
        <>
          <Block>
            <Row label="Version" help="Semantic versions: a patch fixes, a minor adds features, a major needs a step from you (the changelog says which).">
              <span className="font-bold text-fg tabular-nums" data-testid="about-version">
                v{v.version}
              </span>
              {v.sha ? <span className={`${s.unit} tabular-nums`}>· {v.sha}</span> : null}
              {v.dirty > 0 ? (
                <span className="font-bold text-warning-700" data-testid="about-modified" title={`Built with ${v.dirty} locally changed file${v.dirty === 1 ? '' : 's'}`}>
                  · modified
                </span>
              ) : null}
            </Row>
            <Row label="Built" help="When this copy was built (npm run build; in development, when the dev server started).">
              <span className="text-fg tabular-nums">{v.builtAt ? `${fmtDay(v.builtAt, tz)} ${fmtClock(v.builtAt, tz)}` : 'Unknown'}</span>
            </Row>
            <Row label="Database" help="The newest migration applied to your database, and the newest this build ships.">
              <span className="text-fg tabular-nums" data-testid="about-migration">
                {v.dataSource === 'mock' ? 'Mock data (no database)' : (v.migration ?? 'No migrations applied')}
              </span>
              {v.dataSource === 'db' && v.bundledMigration && v.migration !== v.bundledMigration ? <span className={s.unit}>· this build has {v.bundledMigration}</span> : null}
            </Row>
            <Row label="Worker" help="The background process that scans and runs jobs. It should run the same version as the app.">
              <span className="text-fg tabular-nums" data-testid="about-worker">
                {v.workerVersion ? `v${v.workerVersion.replace(/^v/, '')}` : 'Not running'}
              </span>
            </Row>
            <Row label="Persona" help="Your role preset (Settings ▸ Role & rules). It preconfigures what is active; nothing is removed.">
              <span className="text-fg">
                {v.persona.label} · {v.persona.level === 'manager' ? 'Manager' : 'IC'}
              </span>
            </Row>
            {warn ? (
              <Row label="Needs a restart" help="Run the update command from the Command Center folder.">
                <span className="inline-flex items-center gap-1.5 font-bold text-warning-700" data-testid="about-warning">
                  <Glyph name="warn" className={s.attnIcon} />
                  {warn}
                </span>
              </Row>
            ) : null}
            <Row label="Report line" help="Paste it into a bug report or a “which version are you on?” thread.">
              <Button
                variant="secondary"
                size="sm"
                icon="copy"
                onClick={() => {
                  void copyText(versionReport(v)).then(() => toast({ title: 'Version line copied' }));
                }}
              >
                Copy version line
              </Button>
            </Row>
          </Block>
          <Block title="Updates">
            <Row label="Update" help="Pulls, installs, migrates, builds and restarts the web app and the worker, then prints the old → new version.">
              <code className="rounded bg-surface-muted px-1.5 py-0.5 text-caption text-fg">npm run update</code>
            </Row>
            <Row label="What changed" help="Every release has a section, newest first. Majors list the manual step.">
              <code className="rounded bg-surface-muted px-1.5 py-0.5 text-caption text-fg">CHANGELOG.md</code>
              <span className={s.unit}>in the Command Center folder · how releases work: docs/RELEASING.md</span>
            </Row>
            <Row label="README" help="Setup, personas, feedback, updating and where your data lives.">
              <Button variant="secondary" size="sm" onClick={openReadme}>
                Read the README
              </Button>
            </Row>
          </Block>
          <Block title="Guide" actions={<Instant />}>
            <Row label="Getting started" help="The checklist in the sidebar. Its steps tick themselves as you use the app.">
              {guide.guide?.checklistDismissed ? (
                <Button variant="secondary" size="sm" onClick={() => guide.dismissChecklist(false)} data-testid="about-show-checklist">
                  Show the checklist
                </Button>
              ) : (
                <span className="text-fg">Showing in the sidebar</span>
              )}
            </Row>
            <Row label="Page tips" help="The short tips the first time you open a page. The ? next to each page title explains the page any time.">
              <span className="text-fg tabular-nums">
                {seenTips} of {ALL_MARK_IDS.length} seen
              </span>
              <Button variant="secondary" size="sm" onClick={guide.resetGuide} disabled={!guide.ready} data-testid="about-reset-guide">
                Show all tips again
              </Button>
            </Row>
          </Block>
        </>
      )}
    </Section>
  );
}

/** The effect pane: how versions and updates work. */
export function AboutEffect() {
  return (
    <div className="grid gap-3 p-4 text-body" data-testid="about-effect">
      <h3 className="text-body-lg font-bold text-fg-heading">How updates work</h3>
      <ul className="grid gap-1.5 text-fg">
        <li>
          <b>Patch</b> (1.0.<i>1</i>): fixes. Update any time.
        </li>
        <li>
          <b>Minor</b> (1.<i>1</i>.0): new features. Migrations apply on their own.
        </li>
        <li>
          <b>Major</b> (<i>2</i>.0.0): something needs a step from you. The changelog says what, before you update.
        </li>
      </ul>
      <p className="text-muted">The sidebar shows the version under the status line. It turns amber when the web app and the worker run different versions: run npm run update to restart both.</p>
    </div>
  );
}
