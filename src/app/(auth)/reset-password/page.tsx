import type { Metadata } from "next";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";

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
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            This reset link is invalid or has expired. Reset links are good for
            two hours.
          </AlertDescription>
        </Alert>

        <Button asChild className="w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Set a new password." footer={footer}>
      <Card>
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          <CardDescription>
            Setting it signs out every other session on this account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResetPasswordForm token={token} />
        </CardContent>
      </Card>
    </AuthShell>
  );
}
