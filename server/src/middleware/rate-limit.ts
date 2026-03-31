import rateLimit from "express-rate-limit";

/**
 * Strict limiter for auth and credential-issuing endpoints.
 * 20 requests per 15 minutes per IP.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Moderate limiter for public webhook/trigger endpoints.
 * 60 requests per minute per IP.
 */
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/**
 * General API limiter for all authenticated mutation endpoints.
 * 300 requests per minute per IP.
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Strict limiter for agent key / checkout endpoints.
 * 120 requests per minute per IP.
 */
export const agentKeyRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
