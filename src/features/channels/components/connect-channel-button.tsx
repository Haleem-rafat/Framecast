import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * A plain link, not a client action — the connect flow is a full-page
 * navigation to a route handler that sets a cookie and redirects to Google,
 * so there is nothing here for React to manage.
 */
export function ConnectChannelButton({
  size = "default",
}: {
  size?: "default" | "sm";
}) {
  return (
    <Button asChild size={size}>
      <Link href="/api/youtube/connect">
        <Plus />
        Connect a channel
      </Link>
    </Button>
  );
}
