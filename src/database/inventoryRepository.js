// Inventory issue/return ledger per journey. Transactions are immutable (no update of their facts,
// no delete) and a return can never exceed what was issued for the same journey, item and coach
// (trg_inventory_return_limit). Balances are always derived from the ledger, never stored.
import { LocalRuleError } from './errors.js';
import { optionalText, requireDeviceTimestamp, requireUuid } from './captureRules.js';
import { insertStatement } from './sqlHelpers.js';

const LIVE = "sync_status NOT IN ('rejected', 'conflict')";

export function createInventoryRepository(db, { journeys, masters }) {
  async function outstanding(journeyId, itemId, coachCode) {
    const [row] = await db.query(
      `SELECT COALESCE(SUM(CASE txn_type WHEN 'issue' THEN quantity ELSE -quantity END), 0) AS qty
       FROM inventory_transactions WHERE journey_id = ? AND item_id = ? AND coach_code IS ? AND ${LIVE}`,
      [journeyId, itemId, coachCode ?? null],
    );
    return row.qty;
  }

  return {
    outstanding,

    async prepareRecord(p, { actor, nowMs, now, today }) {
      requireUuid(p.id, 'id');
      requireUuid(p.journey_id, 'journey_id');
      requireUuid(p.item_id, 'item_id');
      if (p.device_timestamp) requireDeviceTimestamp(p.device_timestamp, nowMs);
      const journey = await journeys.get(p.journey_id, today);
      if (!journey) throw new LocalRuleError('journey_not_found', 'This journey is not available on this device.');
      if (journey.status === 'cancelled') throw new LocalRuleError('journey_cancelled', 'This journey is cancelled.');
      if (journey.state === 'history') throw new LocalRuleError('journey_closed', 'This journey has ended.');
      const item = await masters.getItem(p.item_id);
      if (!item || item.division_id !== journey.division_id || !item.is_active) {
        throw new LocalRuleError('invalid_item', 'Item not found or inactive in this division.');
      }
      const coach = p.coach_code ? await journeys.coach(journey.id, p.coach_code) : null;
      if (p.coach_code && !coach) throw new LocalRuleError('unknown_coach', 'This coach is not part of the journey.');
      if (p.txn_type !== 'issue' && p.txn_type !== 'return') throw new LocalRuleError('invalid_value', "txn_type must be 'issue' or 'return'.");
      const quantity = Number(p.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
        throw new LocalRuleError('invalid_quantity', 'Quantity must be greater than 0 and at most 1,000,000.');
      }
      if (p.txn_type === 'return') {
        const open = await outstanding(journey.id, item.id, coach?.code ?? null);
        if (quantity > open + 1e-9) {
          throw new LocalRuleError('return_exceeds_issue', 'The return is larger than the quantity issued.', { outstanding: open });
        }
      }
      const row = {
        id: p.id, journey_id: journey.id, division_id: journey.division_id, item_id: item.id, coach_code: coach?.code ?? null,
        txn_type: p.txn_type, quantity, unit: item.unit, remarks: optionalText(p.remarks, 'Remarks', 300),
        recorded_by_id: actor?.id ?? null, device_timestamp: p.device_timestamp ?? null, origin: 'local', sync_status: 'pending',
        created_at: now, updated_at: now,
      };
      return { row, divisionId: journey.division_id, statements: [insertStatement('inventory_transactions', row)] };
    },

    // Ledger rows (backend TxnOut fields plus item name and sync state), oldest first.
    async ledger(journeyId) {
      const rows = await db.query(
        `SELECT t.*, i.name AS item_name FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
         WHERE t.journey_id = ? ORDER BY t.created_at, t.rowid`,
        [journeyId],
      );
      return rows.map((r) => ({ ...r, created_by_id: r.recorded_by_id }));
    },

    // Statements that store server-confirmed transactions (GET /inventory/journeys/{id}/transactions)
    // which this device does not hold yet. Existing rows are never touched (transactions are immutable).
    // Issues are stored before returns so the return-limit trigger sees what was issued.
    async serverStatements(txns, now) {
      if (!txns.length) return [];
      const known = new Set((await db.query(
        `SELECT id FROM inventory_transactions WHERE id IN (${txns.map(() => '?').join(', ')})`, txns.map((t) => t.id),
      )).map((r) => r.id));
      const fresh = txns.filter((t) => t?.id && !known.has(t.id))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || (a.txn_type === 'issue' ? -1 : 1));
      const out = [];
      for (const t of fresh) {
        const item = await masters.getItem(t.item_id);
        if (!item) continue; // item master not on this device yet: keep reading it from the server
        out.push(insertStatement('inventory_transactions', {
          id: t.id, journey_id: t.journey_id, division_id: t.division_id, item_id: t.item_id, coach_code: t.coach_code ?? null,
          txn_type: t.txn_type, quantity: t.quantity, unit: item.unit, remarks: t.remarks ?? null, recorded_by_id: t.created_by_id ?? null,
          device_timestamp: null, origin: 'server', sync_status: 'synced', synced_at: now, server_timestamp: t.created_at,
          created_at: t.created_at ?? now, updated_at: now,
        }));
      }
      return out;
    },

    // Same shape as GET /inventory/journeys/{id}/balance.
    async balance(journeyId) {
      const rows = await db.query(
        `SELECT t.item_id, i.name AS item_name, i.unit, i.ideal_qty, t.coach_code,
                SUM(CASE t.txn_type WHEN 'issue' THEN t.quantity ELSE 0 END) AS issued,
                SUM(CASE t.txn_type WHEN 'return' THEN t.quantity ELSE 0 END) AS returned
         FROM inventory_transactions t JOIN inventory_items i ON i.id = t.item_id
         WHERE t.journey_id = ? AND t.${LIVE}
         GROUP BY t.item_id, t.coach_code ORDER BY i.name, t.coach_code`,
        [journeyId],
      );
      return rows.map((r) => ({ ...r, consumed: r.issued - r.returned }));
    },
  };
}
