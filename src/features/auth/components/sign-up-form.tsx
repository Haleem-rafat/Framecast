"use client";

import { zodResolver } from "@hookform/resolvers/zod";
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
import { signUp } from "@/lib/auth-client";
import {
  MIN_PASSWORD_LENGTH,
  signUpSchema,
  type SignUpInput,
} from "@/schemas/auth.schema";

export function SignUpForm({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  });

  async function onSubmit(values: SignUpInput) {
    setFormError(null);

    const { error } = await signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
    });

    if (error) {
      setFormError(error.message ?? "That account could not be created.");
      return;
    }

    /**
     * Better Auth signs the new account in immediately, but the account is
     * PENDING, so every studio route will bounce it. Going straight to
     * /pending is the honest destination — /dashboard would redirect there
     * anyway, one wasted round trip later.
     */
    router.push("/pending");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {formError && <AuthFormAlert>{formError}</AuthFormAlert>}

      <AuthFieldGroup>
        <AuthField
          id="name"
          label="Name"
          autoComplete="name"
          placeholder="Alex Rivera"
          error={errors.name?.message}
          {...register("name")}
        />

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
          autoComplete="new-password"
          description={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          error={errors.password?.message}
          {...register("password")}
        />

        <AuthField
          id="confirmPassword"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register("confirmPassword")}
        />
      </AuthFieldGroup>

      <AuthSubmitButton
        isSubmitting={isSubmitting}
        pendingLabel="Creating account…"
      >
        Create account
      </AuthSubmitButton>

      {googleEnabled && (
        <div className="space-y-4">
          <AuthDivider>or</AuthDivider>

          {/* Same button as sign-in: Google's flow creates the account if it
              does not exist, and that account waits for approval too. */}
          <GoogleSignInButton redirectTo="/pending" />
        </div>
      )}
    </form>
  );
}
