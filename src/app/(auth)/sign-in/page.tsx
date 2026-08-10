import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { LogoMark } from "@/components/brand/logo-mark";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/config/env";
import { SignInForm } from "@/features/auth/components/sign-in-form";
import { signInErrorMessage } from "@/features/auth/sign-in-error";
import { getSession } from "@/server/session";

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
  const session = await getSession();
  const { redirectTo, error } = await searchParams;
  const destination = safeRedirectTo(redirectTo);

  if (session) {
    redirect(destination);
  }

  const errorMessage = signInErrorMessage(error);

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden p-6">
      {/* Ambient wash. Purely decorative, so it stays out of the a11y tree. */}
      <div
        aria-hidden="true"
        className="from-primary/10 pointer-events-none absolute inset-0 bg-gradient-to-b via-transparent to-transparent"
      />

      <div className="relative w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-xl shadow-sm">
            <LogoMark className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Framecast</h1>
            <p className="text-muted-foreground text-sm">
              Sign in to reach your studio.
            </p>
          </div>
        </div>

        {errorMessage && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Welcome back</CardTitle>
            <CardDescription>
              Enter your credentials to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SignInForm
              redirectTo={destination}
              googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)}
            />
          </CardContent>
        </Card>

        <p className="text-muted-foreground text-center text-xs text-balance">
          Framecast is a single-operator studio. Accounts are provisioned, not
          self-registered.
        </p>
      </div>
    </div>
  );
}
