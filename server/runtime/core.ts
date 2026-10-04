import express from "express";
import { isAllowedClientOrigin, requireTrustedMutationOrigin, getAuthCookieOptions } from '../middleware/client_origin';
export { isAllowedClientOrigin } from '../middleware/client_origin';
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { Server } from "socket.io";
import { getJwtSecret } from "../config/local_identity";

export const asyncHandler = (fn: (req: express.Request, res: express.Response, next?: express.NextFunction) => Promise<any>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export interface AppContext {
  app: express.Express;
  server: http.Server;
  io: Server;
  apiRouter: express.Router;
  PORT: number;
  HOST: string;
  JWT_SECRET: string;
  getCookieOptions: () => { httpOnly: true; secure: boolean; sameSite: "none" | "lax"; maxAge: number };
}

export function resolveBindHost(): string {
  return String(process.env.HOST || '').trim() || '127.0.0.1';
}

export function createApp(): AppContext {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    allowRequest: (req, callback) => callback(null, isAllowedClientOrigin(req.headers.origin)),
    pingInterval: 25_000,
    pingTimeout: 60_000,
    cors: {
      origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => cb(null, isAllowedClientOrigin(origin)),
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  const PORT = Number.parseInt(process.env.PORT || '', 10) || 3000;
  const HOST = resolveBindHost();

  app.use(cors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => cb(null, isAllowedClientOrigin(origin)),
    credentials: true,
  }));
  app.use(requireTrustedMutationOrigin);
  // Capture raw body before JSON parse (needed for WeCom XML webhooks)
  app.use(express.json({
    limit: '10mb',
    verify: (req: any, _res, buf: Buffer) => { req.rawBody = buf.toString('utf8'); },
  }));
  app.use(cookieParser());

  const apiRouter = express.Router();

  // Ensure UTF-8 for API responses
  apiRouter.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
  });

  // Middleware to log API requests for debugging
  apiRouter.use((req, res, next) => {
    console.log(`[API_ROUTER] ${req.method} ${req.path}`);
    next();
  });

  // Mount API router early to ensure it catches requests before static/Vite middleware
  app.use("/api", apiRouter);

  // Global error handler for async route rejections
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('[Express] Unhandled error:', err?.message || err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err?.message || 'Internal server error' });
  });

  const JWT_SECRET = getJwtSecret();

  const getCookieOptions = getAuthCookieOptions;

  return { app, server, io, apiRouter, PORT, HOST, JWT_SECRET, getCookieOptions };
}
