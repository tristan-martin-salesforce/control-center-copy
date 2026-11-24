/** Health, spend audit, setup checks, version. */
import type { In, Out } from './route';

export interface HealthSource {
  getHealth(i: In<'getHealth'>): Out<'getHealth'>;
  /** D0: Spend & decisions for a period, and one day's calls and decisions. */
  getSpendAudit(i: In<'getSpendAudit'>): Out<'getSpendAudit'>;
  getSpendAuditDetail(i: In<'getSpendAuditDetail'>): Out<'getSpendAuditDetail'>;
  reauthConnector(i: In<'reauthConnector'>): Out<'reauthConnector'>;
  scanConnector(i: In<'scanConnector'>): Out<'scanConnector'>;
  getScans(i: In<'getScans'>): Out<'getScans'>;
  getJobs(i: In<'getJobs'>): Out<'getJobs'>;
  retryJob(i: In<'retryJob'>): Out<'retryJob'>;
  /** D-57: version, sha, build time, latest applied migration, persona, the worker's version and whether they differ. */
  getVersion(i: In<'getVersion'>): Out<'getVersion'>;
  /** D-90: queue the update check (db) / answer from the last one (mock: none). Reads only; never installs. */
  checkForUpdates(i: In<'checkForUpdates'>): Out<'checkForUpdates'>;
  /** 11 R6: this Mac's setup checks (src/ops/doctor-service.ts); answers without the database. */
  getDoctor(i: In<'getDoctor'>): Out<'getDoctor'>;
  /** 11 R6: the user's "Check again" for Claude (one tiny model call; refused without a gateway). */
  smokeClaude(i: In<'smokeClaude'>): Out<'smokeClaude'>;
  getEventLog(i: In<'getEventLog'>): Out<'getEventLog'>;
  ackEvent(i: In<'ackEvent'>): Out<'ackEvent'>;
  /** Spend governor (H-5): every hold since a time, the open asks, the receipts' counts. */
  listSpendHolds(i: In<'listSpendHolds'>): Out<'listSpendHolds'>;
  /** Answer a spend ask: Allow $Z more (re-queued or resumed), Allow for today, Stop (settled denied). */
  answerSpendHold(i: In<'answerSpendHold'>): Out<'answerSpendHold'>;
  /** The Assistant card's answer to its turn's spend-ask (the waiting turn continues or wraps up). */
  chatSpendAnswer(i: In<'chatSpendAnswer'>): Out<'chatSpendAnswer'>;
  getGuide(i: In<'getGuide'>): Out<'getGuide'>;
  /** README.md from the app's folder, read-only. */
  getReadme(i: In<'getReadme'>): Out<'getReadme'>;
}
