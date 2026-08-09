import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Clapperboard } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SignInForm } from "@/features/auth/components/sign-in-form";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "Sign in" };

interface SignInPageProps {
  searchParams: Promise<{ redirectTo?: string }>;
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
  const { redirectTo } = await searchParams;
  const destination = safeRedirectTo(redirectTo);

  if (session) {
    redirect(destination);
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-xl">
            <Clapperboard className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">
              Framecast
            </h1>
            <p className="text-muted-foreground text-sm">
              Sign in to reach your studio.
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Welcome back</CardTitle>
            <CardDescription>
              Enter your credentials to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SignInForm redirectTo={destination} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
