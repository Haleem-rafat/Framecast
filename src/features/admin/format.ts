/**
 * Bytes as an operator reads them.
 *
 * Binary units (1024) rather than decimal, because the number this is shown
 * beside is a disk the owner checks with `df`, and `df -h` on the VPS reports
 * GiB while labelling it "G". Matching the tool they would otherwise use
 * matters more here than matching a drive manufacturer.
 *
 * Exported from a plain module rather than living in the component, so the
 * rounding is assertable — 1023 bytes must not render as "1.0 KB" beside a
 * disk that has not filled.
 */
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  // Chosen by magnitude, then clamped: a value past PB is still shown in PB
  // rather than falling off the end of the array as `undefined`.
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    UNITS.length - 1,
  );
  const value = bytes / 1024 ** exponent;

  // Whole bytes never get a decimal point — "512 B", not "512.0 B" — and
  // everything else gets exactly one, so a column of them lines up.
  return exponent === 0
    ? `${Math.round(value)} B`
    : `${value.toFixed(1)} ${UNITS[exponent]}`;
}
