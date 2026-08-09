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
          <AlertTitle>Could not load the dashboard</AlertTitle>
          <AlertDescription>
            {error.message || "An unexpected error occurred."}
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
