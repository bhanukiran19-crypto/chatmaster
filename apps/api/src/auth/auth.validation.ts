import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const passwordSchema = z.string().min(12).max(128);
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((email) => email.toLowerCase())
  .refine((email) => email.endsWith('@gmail.com'), 'Use a Gmail address');
const mobileSchema = z.string().regex(/^\+[1-9][0-9]{6,14}$/);

export const signupSchema = z
  .object({ email: emailSchema, mobile: mobileSchema, password: passwordSchema })
  .strict();
const loginIdentifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine(
    (value) => emailSchema.safeParse(value).success || mobileSchema.safeParse(value).success,
    'Use a valid email or E.164 mobile number',
  )
  .transform((value) => (value.includes('@') ? value.toLowerCase() : value));

export const loginSchema = z
  .object({ identifier: loginIdentifierSchema, password: z.string().min(1).max(128) })
  .strict();
export const emailVerificationSchema = z.object({ token: z.string().min(32).max(256) }).strict();
export const refreshCookieSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const accessCookieSchema = z.string().min(16).max(4096);
export const phoneVerificationSchema = z
  .object({ mobile: mobileSchema, otp: z.string().regex(/^\d{6}$/) })
  .strict();
export const resetRequestSchema = z.object({ email: emailSchema }).strict();
export const passwordResetSchema = z
  .object({ token: z.string().min(32).max(256), password: passwordSchema })
  .strict();

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Invalid request body',
      issues: result.error.issues.map(({ path, code }) => ({ path, code })),
    });
  }
  return result.data;
}
