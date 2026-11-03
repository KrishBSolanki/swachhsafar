// Device capture helpers: GPS fix and camera photo (compressed JPEG data URL for the offline outbox).

export function getPosition({ timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('GPS is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, gps_accuracy_m: Math.min(p.coords.accuracy, 10000) }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission denied. Allow GPS to continue.' : 'Could not get a GPS fix. Try again outdoors.')),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}

// Resizes the camera image so queued evidence stays small enough for SQLite and slow networks.
export function compressImage(file, maxSide = 1280, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the photo.'));
    };
    img.src = url;
  });
}

// Timestamp with the device's timezone offset (the backend rejects naive timestamps).
export function deviceTimestamp(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

export const today = () => deviceTimestamp().slice(0, 10);
export const daysAgo = (n) => deviceTimestamp(new Date(Date.now() - n * 86_400_000)).slice(0, 10);
