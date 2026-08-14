"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import {
  AuthField,
  AuthFieldGroup,
  AuthFormAlert,
  AuthSubmitButton,
} from "@/features/auth/components/auth-form";
import { authClient } from "@/lib/auth-client";
import {
  MIN_PASSWORD_LENGTH,
  resetPasswordSchema,
  type ResetPasswordInput,
} from "@/schemas/auth.schema";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  async function onSubmit(values: ResetPasswordInput) {
    setFormError(null);

    const { error } = await authClient.resetPassword({
      newPassword: values.password,
      token,
    });

    if (error) {
      // Most likely the token expired between the operator relaying it and
      // this submit, so point at the way out rather than just the failure.
      setFormError(
        error.message ??
          "This reset link is no longer valid. Request a new one.",
      );
      return;
    }

    // Every session is revoked on reset (see revokeSessionsOnPasswordReset in
    // src/lib/auth.ts), so there is nothing to return to but the sign-in page.
    toast.success("Password updated. Sign in with your new password.");
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {formError && <AuthFormAlert>{formError}</AuthFormAlert>}

      <AuthFieldGroup>
        <AuthField
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          description={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={errors.password?.message}
          {...register("password")}
        />

        <AuthField
          id="confirmPassword"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register("confirmPassword")}
        />
      </AuthFieldGroup>

      <AuthSubmitButton isSubmitting={isSubmitting} pendingLabel="Updating…">
        Set new password
      </AuthSubmitButton>
    </form>
  );
}
