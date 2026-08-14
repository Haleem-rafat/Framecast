"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side details are stripped from `error` in production; the digest is
    // the only handle that ties this back to the server log entry.
    console.error("Dashboard failed to load", error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md space-y-4">
        <Alert variant="destructive">
          <TriangleAlert />
          {/* This boundary replaces the whole page, PageHeader and its h1
            * included, so without a heading here the document has none at all.
            * Matches the group boundary one level up. */}
          <AlertTitle asChild>
            <h1>Could not load the dashboard</h1>
          </AlertTitle>
          <AlertDescription>
            {error.message || "An unexpected error occurred."}
            {error.digest && (
              // No `opacity-70`: this inherits the destructive foreground,
              // already the lowest-contrast colour on the page, and fading it
              // a further 30% puts the one string an operator has to read back
              // to us — and copy accurately — under 3:1.
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
