/** Pure display helpers. No I/O, no framework imports — safe on both runtimes. */

export function getInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return initials || "?";
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCompactNumber(value: number | bigint): string {
  return compactNumber.format(value);
}

const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

/** Expects a ratio (0.042), not an already-multiplied percentage. */
export function formatPercent(ratio: number): string {
  return percent.format(ratio);
}

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatCurrency(value: number): string {
  return currency.format(value);
}

/** `1.5s` under a minute, `2m 03s` at or above — shared by the render CLI's
 * top-level stage timer and every service's sub-step progress callback, so a
 * "2m 38s" in one place reads the same as a "2m 38s" anywhere else. */
export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Compact, no space before the unit (`4.6MB`, not `4.6 MB`) — matches the
 * render CLI's terse per-clip lines. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0B";
  }
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(1)}${BYTE_UNITS[exponent]}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  const parts = hours > 0 ? [hours, minutes, remainder] : [minutes, remainder];

  return parts
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join(":");
}
