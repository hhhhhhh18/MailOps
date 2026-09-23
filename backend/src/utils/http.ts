import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../config/constants";
import { ValidationError } from "./errors";

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wraps async route handlers so rejections reach the central error middleware. */
export function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function paginationSchema(defaultSize = DEFAULT_PAGE_SIZE) {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(defaultSize),
    sortBy: z.string().optional(),
    sortDir: z.enum(["asc", "desc"]).default("desc"),
  });
}

export type Pagination = z.infer<ReturnType<typeof paginationSchema>>;

export function buildPageMeta(page: number, pageSize: number, total: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export function skipTake(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** Every 2xx JSON body from the API uses this envelope. */
export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200): Response {
  return res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function paginated<T>(res: Response, items: T[], page: PageMeta, extra?: Record<string, unknown>): Response {
  return res.status(200).json({ success: true, data: items, meta: { ...page, ...(extra ?? {}) } });
}

export function created<T>(res: Response, data: T, meta?: Record<string, unknown>): Response {
  return ok(res, data, meta, 201);
}

/**
 * Validates a request payload and rewrites it with parsed values so controllers
 * receive typed, coerced data.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, payload: unknown, label = "payload"): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ValidationError(`Invalid ${label}`, result.error.flatten());
  }
  return result.data;
}

export function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  return parseOrThrow(schema, req.body, "request body");
}

export function parseQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  return parseOrThrow(schema, req.query, "query parameters");
}

export function parseParams<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  return parseOrThrow(schema, req.params, "route parameters");
}

/** Builds a Prisma `orderBy` from a client `sortBy` while whitelisting columns. */
export function buildOrderBy<T extends string>(
  sortBy: string | undefined,
  sortDir: "asc" | "desc",
  allowed: readonly T[],
  fallback: T,
): Record<string, "asc" | "desc"> {
  const column = sortBy && (allowed as readonly string[]).includes(sortBy) ? (sortBy as T) : fallback;
  return { [column]: sortDir };
}

export function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return undefined;
}
