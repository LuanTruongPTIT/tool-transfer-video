export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  const decimals = idx >= 2 ? (val >= 100 ? 0 : 1) : 0;
  return `${val.toFixed(decimals)} ${units[idx]}`;
}

export function formatClockTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');

  if (isToday) {
    return `Hôm nay, ${hh}:${mm}`;
  }
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mo}, ${hh}:${mm}`;
}

export function formatRemainingDuration(expiresAtMs: number): string {
  const diffMs = Math.max(0, expiresAtMs - Date.now());
  const totalMinutes = Math.ceil(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0) {
    return `${hours} giờ ${mins} phút`;
  }
  return `${mins} phút`;
}

export function formatPinDisplay(pin: string): string {
  if (pin.length !== 6) return pin;
  return `${pin.slice(0, 3)} ${pin.slice(3)}`;
}
