'use client';
/**
 * Deals ▸ Missed opportunities (R-UI-14, design v2): a "Log & fix" kind of gap. Opps that look like yours with no
 * DC from you, in two verb sections: Claim (clearly yours) and Check (look first). Every row has one clear verb
 * (Claim, quiet until the row is selected); Dismiss and the evidence sit on hover or selection; each section
 * header carries the batch action (select rows with x or the checkbox, then "Claim N selected").
 *
 * Claim (one Claim verb, D-58) opens the Claim form (split, role, what you did; your role's DC role by default) and
 * adds a DC request: it goes in your next batch, and Deals ▸ DCs lists it; nothing is sent. Only when the app
 * doesn't know the opp is it a task with the Slackbot "DC Comment Upload" prompt draft instead.
 * Claim and Dismiss are optimistic with Undo (auditId); a failure rolls back with an inline toast. Rows you act on
 * stay in place (nothing moves under the cursor); rows that arrive later append below with an "n new" marker.
 * Click or Enter opens the opp in the docked panel; `?account=` narrows the list to one account.
 *
 * Personas (D-55): the page exists only while the persona has the missed-opp sweep. Without it (only a direct link
 * lands here: the tab, links and commands are hidden) it says the sweep is available, not in the role's
 * preconfiguration, with a link to Settings ▸ Role & rules; nothing reads the sweep.
 */
import { FeatureInactive } from '@/components/shell/FeatureInactive';
import { ContextHead, ContextPage } from './context-frame';
import { DealsTabs } from './DealsHeader';
import { MissedSkeleton } from './DealsSkeleton';
import { useContextPanels } from './register-panels';
import { useDealsFeatures, useMissedSweep } from './hooks';
import { MissedSweep } from './MissedView.sweep';

// ── View ────────────────────────────────────────────────────────────────────────────────────

export function MissedView() {
  const f = useDealsFeatures();
  const { ready, missed } = f;
  // Start the sweep's read with the page, as before personas (MissedSweep reads the same query once it mounts).
  useMissedSweep(f);
  // While the persona loads: the route's own skeleton (what the pending navigation showed a moment ago).
  if (!ready) return <MissedSkeleton />;
  if (!missed) return <MissedInactive />;
  return <MissedSweep />;
}

function MissedInactive() {
  useContextPanels();
  return (
    <ContextPage label="Missed opportunities">
      <ContextHead title="Missed opportunities" tabs={<DealsTabs tab="missed" />} />
      <FeatureInactive feature="missedOpps" icon="opportunity" />
    </ContextPage>
  );
}
