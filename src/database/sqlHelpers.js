// Small helpers for building parameterised statements. Table and column names always come from code,
// never from user input; values are always bound parameters.

export const bool = (v) => (v ? 1 : 0);
export const fromBool = (v) => v === 1 || v === true;
export const orNull = (v) => (v === undefined || v === '' ? null : v);
export const parseJson = (text, fallback = null) => {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export function insertStatement(table, row, { orIgnore = false } = {}) {
  const cols = Object.keys(row);
  return {
    sql: `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    params: cols.map((c) => row[c] ?? null),
  };
}

// INSERT ... ON CONFLICT(key) DO UPDATE for every column except the key and `insertOnly` columns.
export function upsertStatement(table, row, { key = ['id'], insertOnly = ['created_at'] } = {}) {
  const cols = Object.keys(row);
  const updates = cols.filter((c) => !key.includes(c) && !insertOnly.includes(c));
  const action = updates.length ? `UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING';
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${key.join(', ')}) DO ${action}`,
    params: cols.map((c) => row[c] ?? null),
  };
}

export const placeholders = (list) => list.map(() => '?').join(', ');

// Standard page envelope used by the FastAPI list endpoints.
export function page(items, { page_size: size = 50, page: n = 1 } = {}) {
  const pageSize = Math.max(1, Math.min(Number(size) || 50, 500));
  const pageNo = Math.max(1, Number(n) || 1);
  return { items: items.slice((pageNo - 1) * pageSize, pageNo * pageSize), total: items.length, page: pageNo, page_size: pageSize };
}
