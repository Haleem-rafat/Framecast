import { formatDistanceToNowStrict } from "date-fns";

interface RelativeTimeProps {
  date: Date;
  className?: string;
}

/**
 * Server-rendered relative timestamp. `suppressHydrationWarning` covers the
 * case where the server and client cross a minute boundary between render and
 * hydration — the text differs by a minute and self-corrects on the next render.
 */
export function RelativeTime({ date, className }: RelativeTimeProps) {
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className={className}
      suppressHydrationWarning
    >
      {formatDistanceToNowStrict(date, { addSuffix: true })}
    </time>
  );
}
