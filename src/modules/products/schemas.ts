import { z } from 'zod';
import { PaiseSchema } from '../../http/schemas.js';

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  unitPricePaise: PaiseSchema,
  stock: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
