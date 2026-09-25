import { Router } from "express";
import { asyncHandler } from "../utils/http";
import { authRateLimit } from "../middleware/security";
import { requireAuth, blockDemoWrites } from "../middleware/auth";
import { validate, validateBody } from "../middleware/validate";
import {
  changePassword,
  changePasswordSchema,
  csrf,
  deleteAccount,
  deleteAccountSchema,
  forgotPassword,
  forgotPasswordSchema,
  login,
  loginSchema,
  logout,
  me,
  refresh,
  register,
  registerSchema,
  resendVerification,
  resetPassword,
  resetPasswordSchema,
  revokeSessions,
  verifyEmail,
  verifyEmailQuerySchema,
} from "../controllers/auth.controller";

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

/**
 * Password lifecycle.
 *
 * /change-password requires a session (and honours the demo account's read-only
 * contract, since changing the shared demo password would lock every visitor out).
 *
 * /forgot-password and /reset-password are public by necessity — the user has no
 * session — so they carry the tighter rate limit, are CSRF-protected like every
 * other POST, and return deliberately generic responses. Neither reveals whether
 * an account exists, and the reset token is single-use and short-lived.
 */
authRouter.post(
  "/change-password",
  requireAuth,
  blockDemoWrites,
  validateBody(changePasswordSchema),
  asyncHandler(changePassword),
);
authRouter.post("/forgot-password", authRateLimit, validateBody(forgotPasswordSchema), asyncHandler(forgotPassword));
authRouter.post("/reset-password", authRateLimit, validateBody(resetPasswordSchema), asyncHandler(resetPassword));

/**
 * Email verification.
 *
 * /verify-email is a GET opened from an email and must stay reachable without a
 * session; it is CSRF-exempt as a safe method and returns only the verdict.
 *
 * /resend-verification requires a session (so there is no enumeration surface),
 * honours the demo account's read-only contract, and carries the tighter rate
 * limit because it sends mail.
 */
authRouter.get("/verify-email", validate({ query: verifyEmailQuerySchema }), asyncHandler(verifyEmail));
authRouter.post(
  "/resend-verification",
  requireAuth,
  blockDemoWrites,
  authRateLimit,
  asyncHandler(resendVerification),
);

/**
 * Account deletion — irreversible, so it carries every guard at once.
 *
 * `authRateLimit` is placed BEFORE `requireAuth` on purpose. Two reasons: throttling
 * unauthenticated traffic is strictly better than letting it reach the auth lookup,
 * and it makes the limiter provably wired to this route (a limiter sitting after
 * `requireAuth` is never reached by an unauthenticated request, which is exactly how
 * the P0-4 rate-limit test ended up asserting the global limiter by mistake).
 *
 * CSRF is applied globally by `csrfMiddleware` like every other mutating route.
 * `blockDemoWrites` keeps the shared demo account undeletable, and the service
 * enforces it a second time so the guard cannot be lost by a routing change.
 */
authRouter.delete(
  "/account",
  authRateLimit,
  requireAuth,
  blockDemoWrites,
  validateBody(deleteAccountSchema),
  asyncHandler(deleteAccount),
);
