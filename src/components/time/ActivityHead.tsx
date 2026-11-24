'use client';
/**
 * The one Activity header (01-ui-audit UI-27, R10): the kit PageHeader on route `time`, so every view (Log it, Needs
 * you, Weeks, Ledger, Use cases, Forecast, VDP) leaves one title to the topbar, read from the route table: "Activity".
 * Before, the head handed the topbar "Time" on the Ledger and Forecast and "VDP" on the VDP view. The view's tabs (the
 * Org62 / VDP areas and their noun tabs, TimeTabs) sit under it as they did.
 *
 * Under the tabs, the page's slice of the one Needs-you queue when the page mounts one (ActivityNeedsSlot, D-86): a
 * section of the view, inside its scroll, so the list below is never pushed under the fold by a fixed block.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { PageHeader } from '@/components/kit';

const NeedsSlot = createContext<ReactNode>(null);

/** What sits under the tabs (app/activity's "Needs you here"); null or absent: nothing. */
export const ActivityNeedsSlot = NeedsSlot.Provider;

export function ActivityHead({ sentence, tabs, actions }: { sentence?: ReactNode; tabs?: ReactNode; actions?: ReactNode }) {
  const needs = useContext(NeedsSlot);
  return (
    <div className="flex shrink-0 flex-col gap-3" data-activity-head="">
      <PageHeader route="time" titleIn="topbar" inset={false} rule={false} sentence={sentence} actions={actions} />
      {tabs}
      {needs ? (
        // a plain wrapper: the queue inside is the "Needs you here" section (one landmark, not two of one name)
        <div className="min-w-0 pt-1" data-testid="activity-needs">
          {needs}
        </div>
      ) : null}
    </div>
  );
}
