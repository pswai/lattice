import type { z } from 'zod';
import { ValidationError } from '../errors.js';

/**
 * Parse a value against a Zod schema, throwing ValidationError on failure.
 * Replaces the 4-line safeParse/throw boilerplate repeated across routes.
 */
export function validate<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError('Invalid input', { issues: result.error.flatten().fieldErrors });
  }
  return result.data;
}
