import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { authRateLimit } from "../middleware/security";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { csrf, login, loginSchema, logout, me, refresh, register, registerSchema, revokeSessions } from "../controllers/auth.controller";

/**
 * Authentication routes.
 *
 * Sign-in endpoints carry the tighter rate limit; /me and /refresh are called by
 * the SPA on every load and must stay cheap.
 *
 * /csrf is the bootstrap for the double-submit token and MUST stay reachable
 * without a session. It is a GET, so `csrfMiddleware` exempts it as a safe method
 * — no route-level exemption is involved. Without it the first login/register has
 * no token to echo and is rejected with 403 before the controller can run.
 */
export const authRouter = Router();

authRouter.get("/csrf", asyncHandler(csrf));

authRouter.post("/register", authRateLimit, validateBody(registerSchema), asyncHandler(register));
authRouter.post("/login", authRateLimit, validateBody(loginSchema), asyncHandler(login));
authRouter.post("/refresh", asyncHandler(refresh));
authRouter.post("/logout", asyncHandler(logout));
authRouter.get("/me", requireAuth, asyncHandler(me));
authRouter.post("/sessions/revoke", requireAuth, asyncHandler(revokeSessions));
