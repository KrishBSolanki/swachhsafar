// In-memory byte store with the same interface as the OPFS worker backend (sqlite.js `workerFiles`).
// Pass the same instance to a re-created store to simulate files surviving an app reload.
export function createMemoryFiles() {
  const map = new Map();
  return {
    map,
    async write(name, bytes) {
      map.set(name, new Uint8Array(bytes));
    },
    async read(name) {
      return map.has(name) ? new Uint8Array(map.get(name)) : null;
    },
    async remove(name) {
      map.delete(name);
    },
    async list() {
      return [...map.keys()];
    },
  };
}
