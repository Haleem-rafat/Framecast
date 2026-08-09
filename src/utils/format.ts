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
