/**
 * The review of a logging canvas before Apply (2026-11-13 audit B2): every row Slackbot will write, by kind, read from
 * the work order itself (exactly what goes), with Remove and Edit. A removed row goes back to waiting (an Event stays
 * approved for the next batch; a DC request or a VDP use case waits for the next canvas). An edit is kept on its own
 * record (the activity row, the DC request, the use case's override) and the work order re-renders; each is one
 * undoable change, and it changes the item's version, so a confirm made before it no longer applies.
 */
import { z } from 'zod';

import { Id, IsoDateTime, Version } from './common';
import { ActivityEntry } from './time';

/** A row's key in the review: stable for the row while its identifying fields stay (`event:<id>`, `uc:<id>`, …). */
export const CanvasRowKey = z.string().min(3).max(200);

export const CanvasReviewEvent = z.object({
  key: CanvasRowKey,
  n: z.number().int(),
  /** The app's activity row (the CC# key); null when the canvas names none the app has. */
  entryId: Id.nullable(),
  subject: z.string(),
  startUtc: z.string(),
  endUtc: z.string(),
  taskType: z.string(),
  hours: z.number(),
  /** WhatId: the opportunity (or the account standing in); '' = internal work, Related To empty. */
  whatId: z.string(),
  oppName: z.string().nullable(),
  accountName: z.string().nullable(),
  /** Meeting_Type__c: set by the task type (Workshop → Data Cloud Workshop, POC → Proof of Concept), else empty. */
  meetingType: z.string(),
  /** The Description's note (D-66), without its CC# key (that key always goes last, unchanged). */
  note: z.string(),
  /** The row as the app has it (for its opp picker and ifVersion); null when there is none. */
  entry: ActivityEntry.nullable(),
});
export type CanvasReviewEvent = z.infer<typeof CanvasReviewEvent>;

export const CanvasReviewDc = z.object({
  key: CanvasRowKey,
  n: z.number().int(),
  kind: z.enum(['add', 'change']),
  /** The DC request it came from (null: the canvas names one the app no longer has). */
  requestId: Id.nullable(),
  oppName: z.string(),
  /** Opportunity__c (an add) or the Deal_Contribution__c record (a change). */
  recordId: z.string(),
  role: z.string(),
  split: z.number(),
  /** A change: the split my DC has now. */
  fromSplit: z.number().nullable(),
  comment: z.string(),
});
export type CanvasReviewDc = z.infer<typeof CanvasReviewDc>;

export const CanvasReviewUseCase = z.object({
  key: CanvasRowKey,
  n: z.number().int(),
  vdpUseCaseId: z.string(),
  name: z.string(),
  opportunityId: z.string(),
  oppName: z.string().nullable(),
  accountId: z.string(),
  product: z.string(),
  agentTypes: z.array(z.string()),
  entitlement: z.string(),
  stage: z.string(),
  goLive: z.string(),
  businessProblem: z.string(),
  kpis: z.string(),
  /** Notes__c without its source line (that line and its CC-UC# key always go last, unchanged). */
  notes: z.string(),
  source: z.string(),
});
export type CanvasReviewUseCase = z.infer<typeof CanvasReviewUseCase>;

export const CanvasReviewUpdate = z.object({
  key: CanvasRowKey,
  n: z.number().int(),
  object: z.string(),
  recordId: z.string(),
  field: z.string(),
  newValue: z.string(),
  currentValue: z.string(),
  why: z.string(),
  /** Whether its new value can be edited here (Duration__c, a use case's Stage__c / Go_Live_Date__c). */
  editable: z.boolean(),
});
export type CanvasReviewUpdate = z.infer<typeof CanvasReviewUpdate>;

/** A Specialist Forecast canvas's row (read-only here: its notes are edited on Forecast). */
export const CanvasReviewForecast = z.object({ key: CanvasRowKey, n: z.number().int(), recordId: z.string(), notes: z.string(), dealRole: z.string() });
export type CanvasReviewForecast = z.infer<typeof CanvasReviewForecast>;

export const CanvasReview = z.object({
  draftId: Id,
  version: Version,
  title: z.string(),
  /** Remove and Edit work while the item waits for Apply; else why not ("Applied: …"). */
  editable: z.boolean(),
  readOnlyWhy: z.string().nullable(),
  /** The work order's size against Slack's limit, in UTF-8 bytes. */
  bytes: z.number().int().min(0),
  maxBytes: z.number().int().min(1),
  counts: z.object({ events: z.number().int(), hours: z.number(), dcs: z.number().int(), useCases: z.number().int(), updates: z.number().int(), forecast: z.number().int() }),
  events: z.array(CanvasReviewEvent),
  dcs: z.array(CanvasReviewDc),
  useCases: z.array(CanvasReviewUseCase),
  updates: z.array(CanvasReviewUpdate),
  forecast: z.array(CanvasReviewForecast),
  /** The picklists the edit forms offer (Org62's values, read from its schema). */
  options: z.object({ ucStages: z.array(z.string()), ucProducts: z.array(z.string()), ucEntitlements: z.array(z.string()), ucAgentTypes: z.array(z.string()) }),
  generatedAt: IsoDateTime,
});
export type CanvasReview = z.infer<typeof CanvasReview>;

export const RemoveCanvasRowsRequest = z.object({ ifVersion: Version, keys: z.array(CanvasRowKey).min(1).max(2000) });
export type RemoveCanvasRowsRequest = z.infer<typeof RemoveCanvasRowsRequest>;

const Text = (max: number) => z.string().max(max);

export const EditCanvasRowRequest = z
  .object({
    ifVersion: Version,
    key: CanvasRowKey,
    /** An Event: the fields the app owns (the subject and times stay the meeting's). `entryVersion`: the row's version you saw. */
    event: z
      .object({
        entryVersion: Version,
        taskType: z.string().min(1).max(80).optional(),
        durationH: z.number().multipleOf(0.25).min(0.25).max(24).optional(),
        oppId: Id.optional(),
        note: Text(1000).optional(),
      })
      .optional(),
    dc: z.object({ split: z.number().int().min(1).max(100).optional(), role: z.string().trim().min(2).max(80).optional(), comment: z.string().trim().min(3).max(1000).optional() }).optional(),
    useCase: z
      .object({
        name: z.string().trim().min(1).max(255).optional(),
        product: z.string().max(40).optional(),
        /** Use_Case_Agent_Type__c values: no count bound here; the server takes only Org62's picklist values (checkedUseCaseFields). */
        agentTypes: z.array(z.string().max(80)).min(1).optional(),
        entitlement: z.string().max(80).optional(),
        stage: z.string().max(80).optional(),
        goLive: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
        businessProblem: Text(32_768).optional(),
        kpis: Text(32_768).optional(),
        notes: Text(32_768).optional(),
      })
      .optional(),
    update: z.object({ newValue: z.string().trim().min(1).max(255) }).optional(),
  })
  .refine((b) => [b.event, b.dc, b.useCase, b.update].filter(Boolean).length === 1, { message: 'edit one row kind: event, dc, useCase or update' });
export type EditCanvasRowRequest = z.infer<typeof EditCanvasRowRequest>;
