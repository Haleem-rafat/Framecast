import { z } from "zod";

/**
 * Shared by the client-side forms and by Better Auth's own `minPasswordLength`
 * in src/lib/auth.ts. Kept here — the one auth module both a client component
 * and the server config can import — so the two can never drift and let a
 * password pass the form only to be refused by the endpoint.
 */
export const MIN_PASSWORD_LENGTH = 12;

const passwordField = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    `Use at least ${MIN_PASSWORD_LENGTH} characters`,
  );

export const signInSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export type SignInInput = z.infer<typeof signInSchema>;

/**
 * `confirmPassword` exists only in the form — registration is irreversible
 * from the operator's side (they cannot retype what they never saw), and a
 * typo would otherwise be discoverable only through the password reset flow,
 * which in this deployment is manual. See src/lib/auth.ts.
 */
export const signUpSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(80),
    email: z.string().min(1, "Email is required").email("Enter a valid email"),
    password: passwordField,
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type SignUpInput = z.infer<typeof signUpSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password: passwordField,
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
