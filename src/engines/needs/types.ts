/**
 * The Needs-you queue's engine types (01 R1, D-86). A provider is a pure function from what the DataSource already
 * read (the context) to rows of one kind; `composeNeeds` orders, dedupes and counts them. Nothing here reads a
 * database or the network: the server gathers the context (src/server/datasource/db/needs.ts) with the existing
 * DataSource reads, so the mock and the db compose the same way.
 */
import type {
  ActivityLog,
  DcSuggestionsPayload,
  GuidePayload,
  HealthPayload,
  ItemsPayload,
  LogCanvas,
  NeedDecision,
  NeedKind,
  NeedRow,
  OutboxPayload,
  PersonaFeature,
  TriagePayload,
  UseCaseCandidatesPayload,
  VdpCoveragePayload,
} from '@/contract';

/**
 * What the providers read. A field is undefined when its read failed or the persona has no use for it (no VDP, no
 * DCs): its provider then returns no rows.
 */
export interface NeedsContext {
  nowMs: number;
  /** The user's IANA zone. */
  timeZone: string;
  /** Its offset now (local wall clock − UTC), minutes. */
  utcOffsetMinutes: number;
  /** The persona's active features (D-55): a verb that needs a missing one is dropped, and so is a row left without its primary verb. */
  features: ReadonlySet<PersonaFeature>;
  triage?: TriagePayload;
  outbox?: OutboxPayload;
  /** The persona logs a task type on every row (its logging profile); default true. */
  taskTypeRequired?: boolean;
  /** Settings ▸ Time ▸ Logging `approveComplete` (a batch also takes complete proposed rows); default true. */
  approveComplete?: boolean;
  /** Activity rows of the last 14 weeks (the live ones and any Org62 no longer has). */
  activity?: Pick<ActivityLog, 'entries'>;
  dc?: DcSuggestionsPayload;
  health?: Pick<HealthPayload, 'spendAsks' | 'setup'>;
  vdp?: Pick<VdpCoveragePayload, 'vdps' | 'notInVdp'>;
  guide?: Pick<GuidePayload, 'items' | 'dismissed'>;
  /** Open work items (Work ▸ All open): reopened ones become reopen_review rows. */
  items?: Pick<ItemsPayload, 'items'>;
  /** Use cases the app noticed (src/engines/use-cases), while the persona has VDP. */
  useCases?: Pick<UseCaseCandidatesPayload, 'enabled' | 'candidates'>;
  /**
   * C6 (activity-at-scale, lane 3): the logging batches the Outbox holds (waiting for your Apply, or an Apply that
   * failed), as Activity's lane 3 reads them (src/server/datasource/log-canvases.ts). Built from `outbox` and
   * `activity`, no read of its own; undefined when either read failed.
   */
  canvases?: readonly Pick<LogCanvas, 'draftId' | 'state' | 'createdAt' | 'maybeCreated'>[];
  /** Snooze decisions on queue rows (`rule: needs:<kind>`, `subjectId`: the row's source id). */
  decisions?: readonly NeedDecision[];
}

export interface NeedProvider {
  kind: NeedKind;
  /** The persona feature the whole kind needs (no VDP: no vdp_change rows). */
  feature?: PersonaFeature;
  run(ctx: NeedsContext): NeedRow[];
}

/** The rule a queue snooze is stored under (the existing Snooze / Not needed decisions, src/contract/needs.ts). */
export const needRule = (kind: NeedKind): string => `needs:${kind}`;

/** `kind:sourceId` → its kind and source id. */
export function splitNeedId(id: string): { kind: string; sourceId: string } {
  const i = id.indexOf(':');
  return i < 0 ? { kind: id, sourceId: '' } : { kind: id.slice(0, i), sourceId: id.slice(i + 1) };
}
