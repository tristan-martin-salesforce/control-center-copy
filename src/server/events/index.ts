/**
 * Live events over Postgres LISTEN/NOTIFY (BE-1a). See docs/reference/WORKER.md "Live events".
 *
 *   // web (CC_DATA=db), inside the DB DataSource:
 *   import { dbLiveEvents } from '@/server/events';
 *   events(i) { return dbLiveEvents(i); }
 *
 *   // worker:
 *   const bus = getLiveEventBus();     // starts LISTEN, installs the change-set commit publisher
 */
export { PgEventBus, LIVE_CHANNEL, CHANGE_CHANNEL, type PgEventBusOptions } from './pg-bus';
export { installChangeSetPublisher, type PublisherOptions } from './publisher';
export { getLiveEventBus, closeLiveEventBus, dbLiveEvents, liveEventsResponse } from './sse';
export { ENTITY_TOPICS, eventsForChanges, MAX_IDS, TABLE_TOPICS, tableTopicsOf, topicsFor, type ChangeRow, type TableTopics, type TopicEvent } from './topics';
