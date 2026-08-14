import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/config/env";
import { AuthCard } from "@/features/auth/components/auth-card";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignInForm } from "@/features/auth/components/sign-in-form";
import { signInErrorMessage } from "@/features/auth/sign-in-error";
import { safeRedirectTo } from "@/lib/safe-redirect";
import { getAccountStatus } from "@/server/session";

export const metadata: Metadata = { title: "Sign in" };

interface SignInPageProps {
  searchParams: Promise<{ redirectTo?: string; error?: string }>;
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

      <AuthCard>
        <CardHeader>
          <CardTitle>Welcome back</CardTitle>
          {/*
            Names the account being signed in to, rather than the previous
            "Enter your credentials to continue." A Google button sits directly
            below this form, and a password field under an unattributed prompt
            beside Google's mark reads as a request for a *Google* password.
            Saying "your Framecast account" costs three words and removes the
            ambiguity for the reader and for anything classifying the page.
          */}
          <CardDescription>
            Sign in to your Framecast account with the email and password you
            registered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm
            redirectTo={destination}
            googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)}
          />
        </CardContent>
      </AuthCard>
    </AuthShell>
  );
}
