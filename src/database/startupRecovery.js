// Runs once when the database opens, before any screen can capture or sync.
//
// The database belongs to one tab at a time (the OPFS access handle is exclusive), so at startup nothing
// else can be working on it: an outbox entry still 'processing' was abandoned by a closed or crashed
// page, and goes back to 'pending' to be delivered again (the server replays an operation it already
// committed, by op_id, so re-delivery is safe). Media files that no metadata row refers to were left by
// a capture whose transaction failed, and are removed. Nothing pending, failed or owned is touched.
import { createOutboxRepository } from './outboxRepository.js';
import { createMediaStore } from './mediaStore.js';

export async function recoverAfterStart({ db, files, now = () => new Date().toISOString(), logger = console }) {
  const result = { requeued: 0, orphansRemoved: 0 };
  try {
    result.requeued = (await createOutboxRepository(db).recoverInterrupted(now()))?.changes ?? 0;
  } catch (e) {
    logger?.warn?.('[startup] outbox recovery failed', e);
  }
  try {
    result.orphansRemoved = (await createMediaStore(db, { files }).sweepOrphans()).length;
  } catch (e) {
    logger?.warn?.('[media] orphan sweep failed', e);
  }
  return result;
}
