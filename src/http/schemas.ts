import { z } from 'zod';

export const ProblemSchema = z
  .looseObject({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    code: z.string(),
    instance: z.string().optional(),
  })
  .describe('RFC 9457 problem details; `code` is stable, extra members carry structured detail');

/** Documents the error statuses a route can return (all share the problem shape). */
export function problems<const S extends number>(
  ...statuses: S[]
): Record<S, typeof ProblemSchema> {
  return Object.fromEntries(statuses.map((s) => [s, ProblemSchema])) as Record<
    S,
    typeof ProblemSchema
  >;
}

export const PaiseSchema = z
  .number()
  .int()
  .nonnegative()
  .describe('Integer amount in paise (INR minor units)');
export const ProductIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/, 'Invalid product id');
export const UuidSchema = z.uuid();
