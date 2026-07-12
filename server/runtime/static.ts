// Vite dev middleware / production static file serving
import express from "express";
import path from "path";
import fs from "fs";

export async function setupStatic(app: express.Express, __filename: string, __dirname: string) {
  const isBundledServer = path.basename(process.cwd()).toLowerCase() === "dist-server" ||
    path.basename(__dirname).toLowerCase() === "dist-server";
  const isSourceServer = __filename.endsWith("server.ts") ||
    process.argv.some(arg => arg.replace(/\\/g, "/").endsWith("/server.ts") || arg === "server.ts");
  const isProduction = process.env.NODE_ENV === "production" ||
    isBundledServer ||
    (!isSourceServer && process.env.NODE_ENV !== "development" && fs.existsSync(path.join(process.cwd(), "dist")));

  // Frontend bundles are split by target: desktop, web, or mobile.
  const frontendTarget = process.env.LUMI_FRONTEND_TARGET || 'desktop';
  const defaultFile = 'index.html';

  if (!isProduction) {
    console.log(`Starting in DEVELOPMENT mode (Vite)...`);
    const { createServer: createViteServer } = await import("vite");
    const hmrPort = Number.parseInt(process.env.LUMI_HMR_PORT || '', 10);
    const serverOptions: Record<string, any> = { middlewareMode: true };
    if (process.env.DISABLE_HMR === 'true') {
      serverOptions.hmr = false;
    } else if (Number.isFinite(hmrPort) && hmrPort > 0) {
      serverOptions.hmr = { port: hmrPort };
    }
    const vite = await createViteServer({
      server: serverOptions,
      appType: "mpa",
    });
    app.use(vite.middlewares);
  } else {
    console.log(`Starting in PRODUCTION mode (Static), frontend=${frontendTarget}...`);
    const explicitDist = process.env.LUMI_FRONTEND_DIST;
    const candidates = [
      explicitDist,
      path.join(process.cwd(), "dist", frontendTarget),
      path.join(process.cwd(), "..", "dist", frontendTarget),
      path.join(process.cwd(), "dist"),
      path.join(process.cwd(), "..", "dist"),
    ].filter(Boolean) as string[];
    const distPath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
    app.use(express.static(distPath));
    app.use("/api/*", (_req, res) => { res.status(404).json({ error: "API route not found" }); });
    app.get("*", (_req, res) => { res.sendFile(path.join(distPath, defaultFile)); });
  }
}
