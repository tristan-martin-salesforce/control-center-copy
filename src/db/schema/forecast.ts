/**
 * Specialist Forecasts (D-55 feature `specialistForecast`): a read-only mirror of the `SpecialistForecast__c` records I
 * own for this and next fiscal quarter, written by the worker's `forecast.sync` (src/jobs/handlers/forecast-sync.ts)
 * through src/server/forecast/store.ts. One row per Org62 record; a later read updates it in place (never a second row).
 *
 *   mirror     every Org62 column below `pending`: replaced on each read
 *   prev_notes the notes before the last change a read saw (History keeps no long-text values), for "last week's note"
 *   pending    the local review state only (a drafted or approved note, an approved Deal Role fix): a read never
 *              touches it, and nothing here is sent anywhere (Apply goes through one Outbox canvas item)
 *
 * Unaudited, like vdp_records: the app writes it from the worker; the Time page refreshes on the `time` topic.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { accounts, opportunities } from './entities';
import { amount, createdAt, id15, ownerUserId, tstz, updatedAt } from './columns';

export const specialistForecasts = pgTable(
  'specialist_forecasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: ownerUserId(),
    /** SpecialistForecast__c.Id (18 characters as Org62 returns it). */
    org62Id: text('org62_id').notNull(),
    name: text('name').notNull(),
    url: text('url'),
    /** Opportunity__c, and the local opp and account it matches (by Org62 id). */
    org62OpportunityId: text('org62_opportunity_id'),
    org62OpportunityId15: id15('org62_opportunity_id15', 'org62_opportunity_id'),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    opportunityName: text('opportunity_name'),
    accountName: text('account_name'),
    oppStage: text('opp_stage'),
    oppNextStep: text('opp_next_step'),
    oppCloseDate: date('opp_close_date'),
    notes: text('notes'),
    prevNotes: text('prev_notes'),
    mgrNotes: text('mgr_notes'),
    dealRole: text('deal_role'),
    judgement: text('judgement'),
    forecastStatus: text('forecast_status'),
    amount: amount('amount'),
    stage: text('stage'),
    closeDate: date('close_date'),
    fiscalQuarter: text('fiscal_quarter'),
    ownerOrg62Id: text('owner_org62_id'),
    lastModifiedAt: tstz('last_modified_at'),
    /** The newest ForecastNotes__c change in SpecialistForecast__History (null: none recorded). */
    notesUpdatedAt: tstz('notes_updated_at'),
    syncedAt: tstz('synced_at').notNull().defaultNow(),
    /** A complete read no longer listed it. Kept, never deleted. */
    goneAt: tstz('gone_at'),
    pending: jsonb('pending').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('specialist_forecasts_owner_org62_uidx').on(t.ownerUserId, t.org62Id),
    index('specialist_forecasts_opportunity_idx').on(t.opportunityId),
    index('specialist_forecasts_owner_quarter_idx').on(t.ownerUserId, t.fiscalQuarter),
    check('specialist_forecasts_org62_id_chk', sql`${t.org62Id} ~ '^[A-Za-z0-9]{15,18}$'`),
  ],
);
