import { z } from 'zod';

/**
 * Wrap an array schema so that MCP clients which stringify array arguments
 * (a known JSON-RPC transport quirk) still pass validation. Empty string
 * coerces to [], and JSON strings are parsed before validation runs.
 */
export function arrayParam<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      if (v === '') return [];
      try { return JSON.parse(v); } catch { return v; /* let zod reject */ }
    },
    schema,
  );
}
