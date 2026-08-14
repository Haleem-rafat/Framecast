import type { Metadata } from "next";
import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      subtitle="Reset the password on your account."
      footer={
        <Link href="/sign-in" className="hover:text-foreground underline">
          Back to sign in
        </Link>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>Forgot your password?</CardTitle>
          <CardDescription>
            Enter the address on the account and a reset link will be issued
            for it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ForgotPasswordForm />

          {/*
            Said on the page rather than buried in a comment, because a person
            waiting for an email that is never coming will assume the studio is
            broken. This is a real limitation of the deployment, not a hedge —
            see PASSWORD_RESET_DELIVERY in src/config/env.ts.
          */}
          <p className="text-muted-foreground text-xs text-balance">
            Framecast has no mail server yet, so the link is not emailed. It is
            written to the activity log, where an operator can find it and pass
            it on to you.
          </p>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
