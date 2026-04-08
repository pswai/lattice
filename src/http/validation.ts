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

/**
 * Parse an optional query string value as an integer.
 * Returns undefined when the param is absent. Throws ValidationError on bad input.
 */
export function optionalInt(raw: string | undefined, name: string, opts?: { min?: number }): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new ValidationError(`${name} must be an integer`);
  if (opts?.min !== undefined && n < opts.min) throw new ValidationError(`${name} must be >= ${opts.min}`);
  return n;
}

/**
 * Parse a required query/path param as an integer. Throws ValidationError on bad input.
 */
export function requireInt(raw: string | undefined, name: string, opts?: { min?: number }): number {
  if (raw === undefined) throw new ValidationError(`${name} is required`);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new ValidationError(`${name} must be an integer`);
  if (opts?.min !== undefined && n < opts.min) throw new ValidationError(`${name} must be >= ${opts.min}`);
  return n;
}
