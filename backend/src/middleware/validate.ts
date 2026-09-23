import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { z } from "zod";
import { ValidationError } from "../utils/errors";

/**
 * Validation middleware.
 *
 * Validated output REPLACES the raw input on the request, so a controller can
 * only ever read schema-checked data. This is what stops an unexpected field
 * (e.g. `role: "ADMIN"`) from reaching a service through an unfiltered spread.
 */

export interface ValidationTargets {
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
}

export function validate(targets: ValidationTargets): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (targets.params) {
        const parsed = targets.params.safeParse(req.params);
        if (!parsed.success) throw new ValidationError("Invalid route parameters", parsed.error.flatten());
        Object.assign(req.params, parsed.data as Record<string, string>);
      }

      if (targets.query) {
        const parsed = targets.query.safeParse(req.query);
        if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.flatten());
        // req.query is a getter-only property in Express 5; assign field-wise.
        Object.defineProperty(req, "query", { value: parsed.data, writable: true, configurable: true });
      }

      if (targets.body) {
        const parsed = targets.body.safeParse(req.body);
        if (!parsed.success) throw new ValidationError("Invalid request body", parsed.error.flatten());
        req.body = parsed.data;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Convenience wrappers. */
export const validateBody = (schema: z.ZodTypeAny): RequestHandler => validate({ body: schema });
export const validateQuery = (schema: z.ZodTypeAny): RequestHandler => validate({ query: schema });
export const validateParams = (schema: z.ZodTypeAny): RequestHandler => validate({ params: schema });
