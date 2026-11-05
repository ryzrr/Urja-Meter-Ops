import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Adds `.openapi()` to Zod schemas. Import `z` from here in any file that documents schemas.
extendZodWithOpenApi(z);

export { z };
