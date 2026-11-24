'use client';
/**
 * Two small blocks the five sections added (01-ui-audit R8):
 *   CoverageSlot   Me ▸ Profile & hours: "AEs I cover", a labelled slot until the attribution engine stores it.
 *   SpendReceipts  Budgets: the spend governor's receipts (GET /spend/holds): what was held, asked, allowed and
 *                  stopped this week, with a link to Health ▸ Spend for every hold.
 */
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { navigate } from '@/components/shell/router';
import { Button, Skeleton } from '@/ui';
import { Block, Row } from './form';

/**
 * D-55 (29-persona-qa decision 1): "AEs I cover" is an SE's list (an SE's book is its opp teams and the AEs it
 * covers). A persona whose book is its own opportunities (the Specialist AE) declares no such list: no row.
 */
export function CoverageSlot() {
  const persona = usePersona();
  if (persona && persona.org62Book !== 'team_member') return null;
  return (
    <Block id="profile-coverage" title="AEs I cover" help="Which account executives you work with, so hours and deal contributions land on their opportunities first.">
      <Row label="Covered AEs" help="Filled in from your opportunities once deal attribution is on. Nothing to set yet.">
        <span className="text-body text-muted" data-testid="profile-coverage-slot">
          Not set up yet
        </span>
      </Row>
    </Block>
  );
}

/** "4 asked · 3 allowed · 1 stopped · usually 12% over its estimate". */
export function receiptsLine(s: { asked: number; approved: number; denied: number; overrunMedianPct: number | null }): string {
  const parts = [`${s.asked} asked`, `${s.approved} allowed`, `${s.denied} stopped`];
  if (s.overrunMedianPct !== null) parts.push(`went past its estimate by ${Math.round(s.overrunMedianPct)}% (median)`);
  return parts.join(' · ');
}

export function SpendReceipts() {
  const q = useApi('listSpendHolds', { query: {} });
  return (
    <Block id="budgets-receipts" title="Receipts" help="Every AI run is estimated before it starts and held against the limits above. Past its estimate, it asks you before going on.">
      {!q.data ? (
        <Skeleton variant="line" count={2} />
      ) : (
        <Row label="Last 7 days" help="Asked: a run went past its estimate and waited for you.">
          <span className="text-body text-fg tabular-nums" data-testid="budgets-receipts">
            {q.data.holds.length} runs held · {receiptsLine(q.data.summary)}
          </span>
          <Button variant="secondary" size="sm" onClick={() => navigate('/health')}>
            See every run in Health
          </Button>
        </Row>
      )}
    </Block>
  );
}
