// Subscribes to the sync service and wires the automatic triggers:
// app startup, network reconnection and returning to the foreground.
import { useEffect, useSyncExternalStore } from 'react';
import { subscribeConnectivity, subscribeForeground } from '../services/connectivityService.js';

const EMPTY = { running: false, pendingCount: 0, lastSyncAt: null, lastError: null, needsPassword: [], users: [], outbox: {} };
const noopSubscribe = () => () => {};

export function useSyncStatus(syncService) {
  const state = useSyncExternalStore(
    syncService ? syncService.subscribe : noopSubscribe,
    syncService ? syncService.getState : () => EMPTY,
  );

  useEffect(() => {
    if (!syncService) return undefined;
    syncService.start();
    const offConnectivity = subscribeConnectivity((online) =>
      online ? syncService.sync({ trigger: 'reconnect' }) : syncService.refresh(),
    );
    const offForeground = subscribeForeground(() => syncService.sync({ trigger: 'foreground' }));
    return () => {
      offConnectivity();
      offForeground();
    };
  }, [syncService]);

  return state;
}
