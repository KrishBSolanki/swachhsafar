// Wraps a sqlite-wasm oo1 database in the small async interface the repositories use:
//   query(sql, params) -> rows, run(sql, params) -> { changes }, transaction(statements)
// The same adapter backs the OPFS worker in the browser and the in-memory DB in tests.

const toBind = (params = []) => params.map((v) => (v === undefined ? null : v));

export function createOo1Adapter(db) {
  return {
    async query(sql, params) {
      return db.selectObjects(sql, toBind(params)).map((row) => ({ ...row }));
    },

    async run(sql, params) {
      db.exec({ sql, bind: toBind(params) });
      return { changes: db.changes() };
    },

    // Runs every statement atomically; any failure rolls back the whole batch.
    async transaction(statements) {
      const results = [];
      db.transaction(() => {
        for (const { sql, params } of statements) {
          db.exec({ sql, bind: toBind(params) });
          results.push({ changes: db.changes() });
        }
      });
      return results;
    },

    async close() {
      db.close();
    },
  };
}
