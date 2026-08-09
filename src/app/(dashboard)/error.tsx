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
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>
            This page could not be loaded. Try again, or head back to the
            dashboard if the problem continues.
            {error.digest && (
              <span className="mt-1 block font-mono text-xs opacity-70">
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
