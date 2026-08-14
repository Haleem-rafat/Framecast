/**
 * The origin `safeRedirectTo` resolves candidates against.
 *
 * Deliberately a `.invalid` host (RFC 2606) rather than SITE_URL: this value
 * is never navigated to and never rendered, it exists only so the URL parser
 * has something to resolve a relative reference against. Using a reserved TLD
 * makes it impossible for a mistake here to ever produce a working link to
 * somewhere real.
 */
const PROBE_ORIGIN = "https://redirect-probe.invalid";

/**
 * Reduces an untrusted `?redirectTo=` to a path that provably cannot leave
 * this origin, or to `fallback` if it cannot.
 *
 * The obvious version of this check is `value.startsWith("/") &&
 * !value.startsWith("//")`, and it is wrong. Browsers treat a backslash as a
 * forward slash while parsing the authority component, so `/\evil.example`
 * passes both of those conditions and still resolves to `https://evil.example`
 * — as does `/%5cevil.example` once decoded. That is a working open redirect:
 * an attacker sends `…/sign-in?redirectTo=/\evil.example`, the victim signs in
 * with real credentials on the real domain, and is then handed to a page under
 * the attacker's control that can claim the session expired and ask again. It
 * is also, on its own, something an automated phishing classifier will flag,
 * because a login page that forwards to arbitrary hosts is a phishing
 * primitive whatever the site around it happens to be.
 *
 * So rather than enumerate the encodings that must be rejected — a list that
 * has historically only ever grown — this parses the candidate with the same
 * algorithm the browser will use and keeps it only if it landed on the probe
 * origin. What is returned is then re-serialised from the parse result, not
 * echoed from the input, so the caller receives a value that is same-origin by
 * construction and already normalised the way the browser would normalise it.
 */
export function safeRedirectTo(
  value: string | undefined | null,
  fallback = "/dashboard",
): string {
  // A candidate that is not a rooted path is not a destination on this site,
  // whatever else it might be. Checked before parsing because an absolute URL
  // to this very origin would otherwise survive the origin comparison below,
  // and there is no reason for one to arrive in this parameter.
  if (!value?.startsWith("/")) {
    return fallback;
  }

  /**
   * `/%2f…` and `/%5c…` are, strictly, ordinary same-origin paths — neither a
   * browser nor `new URL` decodes them before deciding on the authority, so
   * the origin check below already accepts them and is right to. They are
   * refused anyway because nothing in this app ever produces one, and the
   * check below is only as trustworthy as the agreement between this parser
   * and every proxy in front of it. A reverse proxy that normalises `%2f` to
   * `/` before the app sees it would turn one of these back into the
   * protocol-relative form the origin check was meant to catch. Declining a
   * shape that has no legitimate use is cheaper than depending on that
   * agreement holding.
   */
  if (/^\/(?:%2f|%5c)/i.test(value)) {
    return fallback;
  }

  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return fallback;
  }

  if (resolved.origin !== PROBE_ORIGIN) {
    return fallback;
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
