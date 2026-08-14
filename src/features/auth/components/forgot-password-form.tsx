"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <Alert>
        <CheckCircle2 />
        <AlertDescription>
          If that address has an account, a reset link has been issued for it.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      {formError && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={Boolean(errors.email)}
          {...register("email")}
        />
        {errors.email && (
          <p className="text-destructive text-xs">{errors.email.message}</p>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" />}
        {isSubmitting ? "Requesting…" : "Request reset link"}
      </Button>
    </form>
  );
}
