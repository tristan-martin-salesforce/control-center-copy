/**
 * The component kit (01-ui-audit R10; docs/UX.md "Component kit"): four composites on top of the @/ui primitives,
 * plus the drain mode. New rows use ActionRow; new verb sections use QueueSection; every page header is a PageHeader;
 * Details panels are DetailPanels over the section registry. Tailwind and tokens only. The spec is /dev/kit.
 */
export { ActionRow, TintChip, type ActionRowProps, type ActionRowVerb, type ActionRowOverflow, type ActionRowSource } from './ActionRow';
export { QueueSection, type QueueSectionProps, type QueueRowContext } from './QueueSection';
export { PageHeader, pageTitle, type PageHeaderProps, type PageRoute } from './PageHeader';
export { DetailPanel, DoneMenu, LaterMenu, registerSectionedPanel, type DetailPanelProps, type ItemMenuProps } from './DetailPanel';
export { registerDetailSections, getDetailSections, useDetailSections, sortSections, type DetailSection } from './detail-sections';
export { ReviewQueue, type ReviewQueueProps, type ReviewAdapter, type ReviewCardContext, type ReviewVerb } from './ReviewQueue';
export { useItemMenus, type ItemMenuHandlers } from './useItemMenus';
export {
  DONE_CHOICES,
  LATER_CHOICES,
  doneRequest,
  laterRequest,
  laterTargets,
  nextWorkingDayAt9,
  nextMondayAt9,
  tomorrowAt9,
  pickedDayAt9,
  type DoneChoice,
  type LaterChoice,
  type MenuRequest,
} from './item-menus';
export { LanePage, LANE_TWO_COLUMN_MIN, laneColumns, useLaneColumns, type LanePageProps, type Lane, type LaneHeader } from './LanePage';
export { RowGrid, moveRowFocus, type RowDensity, type CompactSlots, type RowCheck } from './ActionRowCompact';
