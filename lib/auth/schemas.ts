import { z } from "zod";

/**
 * Auth input schemas, shared by the sign-in/sign-up forms and the route handlers.
 * No server-only imports.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: "Enter a valid email address." }));

export const PASSWORD_RULES = [
  { id: "length", label: "At least 8 characters", test: (v: string) => v.length >= 8 && v.length <= 128 },
  { id: "letter", label: "At least one letter", test: (v: string) => /\p{L}/u.test(v) },
  { id: "digit", label: "At least one number", test: (v: string) => /\d/.test(v) },
] as const;

export const passwordSchema = z
  .string()
  .max(128, { error: "Use at most 128 characters." })
  .refine((v) => PASSWORD_RULES.every((rule) => rule.test(v)), {
    error: "Use at least 8 characters, including a letter and a number.",
  });

/** Sign-in accepts any non-empty password so old rules never lock anyone out. */
export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().max(100).optional(),
});

export const tokenSchema = z.string().trim().min(20).max(200);

export const verifyEmailSchema = z.object({ token: tokenSchema });
export const emailOnlySchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });

export type RegisterInput = z.infer<typeof registerSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
