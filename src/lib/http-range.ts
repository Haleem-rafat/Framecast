/**
 * Parses a single-range HTTP `Range` header against a known file size.
 *
 * This exists because finished renders moved from Vercel Blob to local disk.
 * Blob implemented RFC 7233 server-side and `/api/videos/[id]/file` merely
 * forwarded the header to it; a filesystem answers no such thing, so the
 * parsing that route deleted when it adopted Blob has to come back — this
 * time isolated from any I/O so every edge can be tested cheaply.
 *
 * Returns `null` to mean "serve the whole file": no header, a malformed one,
 * or a multi-range request, which is legal but would require a
 * `multipart/byteranges` body no video player in this app ever asks for.
 * Returns `"unsatisfiable"` for a range that starts at or past the end, which
 * the caller must answer with 416 rather than silently serving something else.
 */
export interface ByteRange {
  start: number;
  end: number;
}

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

export function parseRangeHeader(
  header: string | null | undefined,
  sizeBytes: number,
): ByteRange | null | "unsatisfiable" {
  if (!header) {
    return null;
  }

  const match = RANGE_PATTERN.exec(header.trim());

  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;

  // `bytes=-` matches the pattern but names neither bound.
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  // An empty file can satisfy no range at all, including `bytes=0-`.
  if (sizeBytes === 0) {
    return "unsatisfiable";
  }

  const lastByte = sizeBytes - 1;

  // Suffix form: `bytes=-500` means the final 500 bytes, not "up to byte 500".
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, sizeBytes - suffixLength), end: lastByte };
  }

  const start = Number(rawStart);

  if (start > lastByte) {
    return "unsatisfiable";
  }

  // An absent or over-long end is clamped rather than rejected: browsers
  // routinely ask for more than exists at the tail of a file.
  const end = rawEnd === "" ? lastByte : Math.min(Number(rawEnd), lastByte);

  if (end < start) {
    return null;
  }

  return { start, end };
}
