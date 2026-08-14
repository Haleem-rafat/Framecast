"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import {
  AuthDivider,
  AuthField,
  AuthFieldGroup,
  AuthFormAlert,
  AuthSubmitButton,
} from "@/features/auth/components/auth-form";
import { GoogleSignInButton } from "@/features/auth/components/google-sign-in-button";
import { signIn } from "@/lib/auth-client";
import { signInSchema, type SignInInput } from "@/schemas/auth.schema";

export function SignInForm({
  redirectTo,
  googleEnabled,
}: {
  redirectTo: string;
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: SignInInput) {
    setFormError(null);

    const { error } = await signIn.email({
      email: values.email,
      password: values.password,
    });

    if (error) {
      // Deliberately not distinguishing unknown-email from wrong-password.
      setFormError(error.message ?? "Invalid email or password.");
      return;
    }

    router.push(redirectTo);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {formError && <AuthFormAlert>{formError}</AuthFormAlert>}

      <AuthFieldGroup>
        <AuthField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          error={errors.email?.message}
          {...register("email")}
        />

        <AuthField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          labelAction={
            <Link
              href="/forgot-password"
              className="text-muted-foreground hover:text-foreground rounded-xs text-xs underline underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Forgot password?
            </Link>
          }
          {...register("password")}
        />
      </AuthFieldGroup>

      <AuthSubmitButton isSubmitting={isSubmitting} pendingLabel="Signing in…">
        Sign in
      </AuthSubmitButton>

      {googleEnabled && (
        // The divider and the button it introduces are one block, closer to
        // each other than the block is to the credential form above it.
        <div className="space-y-4">
          <AuthDivider>or</AuthDivider>

          <GoogleSignInButton redirectTo={redirectTo} />
        </div>
      )}
    </form>
  );
}
