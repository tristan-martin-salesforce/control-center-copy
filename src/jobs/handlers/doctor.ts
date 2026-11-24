/**
 * `doctor.checks` (queue `maintenance`, 11 R6): the doctor's checks every 15 minutes and right after the worker starts
 * (src/worker/schedules.ts). The report goes to the state folder (`doctor.json`: Health ▸ Setup and GET /doctor read
 * it), and every failing check with a catalog code becomes ONE open app_events row (component `doctor`, fingerprint
 * `doctor|<code>`): repeats bump its count, and it is resolved when the check passes. jobs.result holds counts and
 * codes only. Reads only: nothing here starts a sign-in or spends.
 */
import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { entryOf } from '@/errors/catalog';
import { render } from '@/errors/render';
import { doctorCachePath, writeCachedReport } from '@/ops/doctor-service';
import { codesOf, failingCodes, realContext, runDoctor, type DoctorContext, type DoctorReport } from '@/ops/doctor';
import { SETTINGS_SOURCES_CODE, settingsSourcesMessage, type SettingsSourcesSuspect } from '@/ops/scanner-auth';

import type { JobHandlerDef } from '../types';

export const DOCTOR_JOB_KIND = 'doctor.checks';
export const DOCTOR_COMPONENT = 'doctor';

/** The prefixes recorded as events (a DEP/AUTH/DATA/MCP/RATE problem the user can act on; BUG.CHECK_CRASHED too). */
const RECORDED = /^(DEP|AUTH|DATA|MCP|RATE|BUG\.CHECK_CRASHED)/;

const errorClassOf = (code: string): string | null => {
  const c = entryOf(code).class;
  return c === 'auth' ? 'auth' : c === 'rate' ? 'rate_limited' : c === 'network' ? 'transient' : c === 'bug' ? 'bug' : null;
};

/** Upsert one row per failing code, resolve the doctor's rows whose code passes now. Returns the open codes. */
export async function recordDoctorEvents(db: DbOrTx, userId: string, r: Pick<DoctorReport, 'checks'>): Promise<string[]> {
  const codes = failingCodes(r).filter((c) => RECORDED.test(c));
  for (const code of codes) {
    const check = r.checks.find((c) => codesOf(c).includes(code))!;
    const e = render(code);
    const severity = e.severity === 'critical' ? 'critical' : check.status === 'fail' ? 'error' : 'warn';
    await db.execute(sql`
      insert into app_events (owner_user_id, severity, component, code, error_class, message, detail, fingerprint)
      values (${userId}, ${severity}, ${DOCTOR_COMPONENT}, ${code}, ${errorClassOf(code)}, ${`${e.title}: ${check.detail}`.slice(0, 200)},
              ${JSON.stringify({ check: check.id, state: check.state ?? null, suggestedAction: e.nextStep })}::jsonb, ${`${DOCTOR_COMPONENT}|${code}`})
      on conflict (fingerprint) where resolved_at is null
      do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), message = excluded.message,
                    detail = excluded.detail, severity = excluded.severity`);
  }
  await db.execute(sql`
    update app_events set resolved_at = now()
     where component = ${DOCTOR_COMPONENT} and resolved_at is null
       and not (code = any(${`{${codes.map((c) => `"${c}"`).join(',')}}`}::text[]))`);
  return codes;
}

/**
 * W0-1: the settings-sources suspect, written the moment the worker sees it (src/worker/scanning.ts `onScanOutcome`)
 * with the doctor's fingerprint, so it is the same one open row the 15-minute run keeps or resolves.
 */
export async function recordSettingsSourcesEvent(db: DbOrTx, userId: string, s: SettingsSourcesSuspect): Promise<void> {
  const e = render(SETTINGS_SOURCES_CODE);
  await db.execute(sql`
    insert into app_events (owner_user_id, severity, component, code, error_class, message, detail, fingerprint)
    values (${userId}, 'error', ${DOCTOR_COMPONENT}, ${SETTINGS_SOURCES_CODE}, null, ${`${e.title}: ${settingsSourcesMessage(s)}`.slice(0, 200)},
            ${JSON.stringify({ check: 'settings-sources', connector: s.connector, why: s.why, failed: s.code, suggestedAction: e.nextStep })}::jsonb,
            ${`${DOCTOR_COMPONENT}|${SETTINGS_SOURCES_CODE}`})
    on conflict (fingerprint) where resolved_at is null
    do update set occurrence_count = app_events.occurrence_count + 1, last_occurred_at = now(), detail = excluded.detail`);
}

export function doctorJobDef(o: { context?: () => Promise<DoctorContext>; cacheFile?: () => string } = {}): JobHandlerDef {
  return {
    kind: DOCTOR_JOB_KIND,
    queue: 'maintenance',
    wired: true,
    description: "doctor's setup checks every 15 min and after start: the report for Health ▸ Setup, one open event per failing code",
    handler: async (ctx) => {
      // budget is Health's own spend line; the maintainer-only checks skip by themselves
      const report = await runDoctor(await (o.context ?? realContext)(), { skip: ['budget'] });
      writeCachedReport(report, (o.cacheFile ?? (() => doctorCachePath()))());
      const open = await recordDoctorEvents(ctx.db, ctx.userId, report);
      ctx.log('doctor: checks done', { ...report.summary, codes: open });
      return { ...report.summary, codes: open };
    },
  };
}
