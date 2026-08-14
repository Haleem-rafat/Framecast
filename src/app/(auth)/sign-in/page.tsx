import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/config/env";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignInForm } from "@/features/auth/components/sign-in-form";
import { signInErrorMessage } from "@/features/auth/sign-in-error";
import { getAccountStatus } from "@/server/session";

export const metadata: Metadata = { title: "Sign in" };

interface SignInPageProps {
  searchParams: Promise<{ redirectTo?: string; error?: string }>;
}

/** Only same-origin relative paths are honoured, to prevent open redirects. */
function safeRedirectTo(value: string | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }
  return value;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  // `getAccountStatus()` rather than `getSession()`: to the gated accessor an
  // unapproved account looks signed out, so this page would show the form to
  // someone who is already signed in and send them round the loop again.
  const status = await getAccountStatus();
  const { redirectTo, error } = await searchParams;
  const destination = safeRedirectTo(redirectTo);

  if (status) {
    redirect(status.approval === "APPROVED" ? destination : "/pending");
  }

  const errorMessage = signInErrorMessage(error);

  return (
    <AuthShell
      subtitle="Sign in to reach your studio."
      footer={
        <>
          New here?{" "}
          <Link href="/sign-up" className="hover:text-foreground underline">
            Create an account
          </Link>
          . Every account is reviewed by an operator before it can be used.
        </>
      }
    >
      {errorMessage && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Enter your credentials to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm
            redirectTo={destination}
            googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)}
          />
        </CardContent>
      </Card>
    </AuthShell>
  );
}
