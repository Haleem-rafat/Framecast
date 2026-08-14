"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Catch-all error boundary for every dashboard route that doesn't have a
 * more specific one (dashboard/error.tsx is nearer and wins for /dashboard
 * itself). Matches its shape, but deliberately never renders `error.message`:
 * Next only strips that to a generic string in production, so in dev — or
 * for an error thrown outside the `run()`/toSerializedError funnel — it can
 * still carry a raw driver message. A fixed, generic copy is the only way to
 * guarantee that never reaches the browser.
 */
export default function DashboardGroupError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle that ties this back to the server log entry.
    console.error("A dashboard route failed to load", error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md space-y-4">
        <Alert variant="destructive">
          <TriangleAlert />
          {/* This boundary replaces the whole page, `PageHeader` included, so
            * without a real heading here the document has none at all — no h1
            * to land on, nothing for a screen reader's heading list. AlertTitle
            * is a styled `<div>`; `asChild` keeps its styling and lets the h1
            * be the element that actually renders. */}
          <AlertTitle asChild>
            <h1>Something went wrong</h1>
          </AlertTitle>
          <AlertDescription>
            This page could not be loaded. Try again, or head back to the
            dashboard if the problem continues.
            {error.digest && (
              // No `opacity-70`: this text inherits the destructive foreground,
              // which is already the lowest-contrast colour on the page, and
              // fading it a further 30% puts the one string an operator has to
              // read back to us — and copy accurately — under 3:1.
              <span className="mt-1 block font-mono text-xs">
                Reference: {error.digest}
              </span>
            )}
          </AlertDescription>
        </Alert>

        <Button onClick={reset} variant="outline" className="w-full">
          <RotateCw />
          Try again
        </Button>
      </div>
    </div>
  );
}
