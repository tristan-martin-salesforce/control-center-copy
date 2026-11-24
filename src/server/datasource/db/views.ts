/**
 * The db DataSource's imports of the shared read views. Every read body lives once in src/server/views/ (no twins
 * left: the Work lists, Today, Triage and the Time week included); what SQL decides (the Work list's candidates, Q1's
 * order, Q6's closes, the since-you-left entries) the domain passes in.
 */
import { fmtHM, hrefFor, isLive, itemRef } from '../mock/views';
export { isMyOpp, sweptOppIds } from '../mock/views';
import { hydrateItem, nowCardFor } from '@/server/views/work';
import { healthSummary } from '@/server/views/health';
import { buildOutbox } from '@/server/views/drafts';
import { buildSince } from '@/server/views/universal';

export { fmtHM, hrefFor, isLive, itemRef };
// R7 step 3: the read bodies both DataSources share live in src/server/views/ (re-exported for the existing imports;
// Today, Triage and the Time week: views/{today,triage,time}.ts)
export { buildOutbox, buildSince, healthSummary, hydrateItem, nowCardFor };
