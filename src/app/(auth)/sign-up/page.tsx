import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/config/env";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignUpForm } from "@/features/auth/components/sign-up-form";
import { getAccountStatus } from "@/server/session";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignUpPage() {
  const status = await getAccountStatus();

  // Someone already signed in has no business on this page, approved or not.
  if (status) {
    redirect(status.approval === "APPROVED" ? "/dashboard" : "/pending");
  }

  return (
    <AuthShell
      subtitle="Request access to the studio."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/sign-in" className="hover:text-foreground underline">
            Sign in
          </Link>
          .
        </>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            Anyone can register, but an existing operator has to approve the
            account before it can open the studio.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignUpForm googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)} />
        </CardContent>
      </Card>
    </AuthShell>
  );
}
