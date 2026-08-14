"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { CheckCircle2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AuthField,
  AuthFieldGroup,
  AuthFormAlert,
  AuthSubmitButton,
} from "@/features/auth/components/auth-form";
import { authClient } from "@/lib/auth-client";
import {
  forgotPasswordSchema,
  type ForgotPasswordInput,
} from "@/schemas/auth.schema";

export function ForgotPasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [isSent, setIsSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit(values: ForgotPasswordInput) {
    setFormError(null);

    const { error } = await authClient.requestPasswordReset({
      email: values.email,
      // Where the link lands once Better Auth has checked the token is still
      // valid; it arrives there as ?token=… or ?error=INVALID_TOKEN.
      redirectTo: "/reset-password",
    });

    if (error) {
      setFormError(error.message ?? "The request could not be sent.");
      return;
    }

    setIsSent(true);
  }

  /**
   * Deliberately says nothing about whether the address exists — the endpoint
   * returns the same response either way, and contradicting it here would turn
   * this form into an account-enumeration oracle. It also does not claim an
   * email was sent, because in this deployment none was: see the note the page
   * renders underneath.
   */
  if (isSent) {
    return (
      <Alert className="animate-in fade-in slide-in-from-top-1 border-border/70 duration-200 motion-reduce:animate-none">
        <CheckCircle2 />
        <AlertDescription>
          If that address has an account, a reset link has been issued for it.
        </AlertDescription>
      </Alert>
    );
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
      </AuthFieldGroup>

      <AuthSubmitButton isSubmitting={isSubmitting} pendingLabel="Requesting…">
        Request reset link
      </AuthSubmitButton>
    </form>
  );
}
