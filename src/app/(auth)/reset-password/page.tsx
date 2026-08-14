import type { Metadata } from "next";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuthCard } from "@/features/auth/components/auth-card";
import { authControlClassName } from "@/features/auth/components/auth-form";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Set a new password" };

interface ResetPasswordPageProps {
  /**
   * Better Auth's /reset-password/:token callback checks the token has not
   * expired and then bounces the browser here with either ?token=… or
   * ?error=INVALID_TOKEN. Both cases are rendered below; the token is only
   * ever handed straight back to Better Auth, never inspected here.
   */
  searchParams: Promise<{ token?: string; error?: string }>;
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { token, error } = await searchParams;

  const footer = (
    <Link href="/sign-in" className="hover:text-foreground underline">
      Back to sign in
    </Link>
  );

  if (!token || error) {
    return (
      <AuthShell subtitle="Set a new password." footer={footer}>
        {/* Same card surface as the working path, so the dead-end link does not
            land the visitor on a page that looks like a different site. */}
        <AuthCard>
          <CardContent className="space-y-5">
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/5 dark:bg-destructive/10"
            >
              <TriangleAlert />
              <AlertDescription>
                This reset link is invalid or has expired. Reset links are good
                for two hours.
              </AlertDescription>
            </Alert>

            {/* Cut to the same block as every other action under (auth) — see
                authControlClassName for why that block is the size it is. */}
            <Button
              asChild
              className={cn(authControlClassName, "text-sm leading-5 shadow-sm")}
            >
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
          </CardContent>
        </AuthCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Set a new password." footer={footer}>
      <AuthCard>
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          <CardDescription>
            Setting it signs out every other session on this account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResetPasswordForm token={token} />
        </CardContent>
      </AuthCard>
    </AuthShell>
  );
}
