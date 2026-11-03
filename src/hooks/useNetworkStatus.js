import { useSyncExternalStore } from 'react';
import { isOnline, subscribeConnectivity } from '../services/connectivityService.js';

export function useNetworkStatus() {
  return useSyncExternalStore((onChange) => subscribeConnectivity(onChange), isOnline);
}
