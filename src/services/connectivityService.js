// Browser connectivity signals. navigator.onLine === false reliably means offline;
// true only means "has a network", so sync still treats request failures as retryable.

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

export function subscribeConnectivity(callback) {
  const onOnline = () => callback(true);
  const onOffline = () => callback(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}

// Fires when the app returns to the foreground (e.g. reopening the installed PWA).
export function subscribeForeground(callback) {
  const onVisible = () => {
    if (document.visibilityState === 'visible') callback();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
