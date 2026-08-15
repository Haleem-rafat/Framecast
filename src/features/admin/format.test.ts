import { describe, expect, it } from "vitest";

import { formatBytes } from "@/features/admin/format";

describe("formatBytes", () => {
  it("shows whole bytes without a decimal point", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("does not round a value up into the next unit", () => {
    // The failure this exists to prevent: a disk that has not reached a
    // kilobyte reading as "1.0 KB" beside a figure the owner is checking
    // against `df`.
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("uses binary units, matching what df -h reports on the VPS", () => {
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    // 1e9 bytes is a decimal gigabyte and must not read as 1.0 GB here.
    expect(formatBytes(1_000_000_000)).toBe("953.7 MB");
  });

  it("treats nothing stored as zero rather than as an error", () => {
    // `Asset.sizeBytes` is nullable and the aggregate returns null for an
    // empty table, which the service coerces to 0.
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("clamps past the largest unit rather than falling off the array", () => {
    expect(formatBytes(1024 ** 7)).toContain("PB");
  });
});
