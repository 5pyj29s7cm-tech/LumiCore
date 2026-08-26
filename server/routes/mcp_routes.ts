import { Router } from "express";
import { requireAdmin, requireAuth, requireLocalRequest } from "../middleware/auth";
import { mcpManager, getMCPConfig, updateMCPConfig, recoverServerTools } from "../mcp";
import { logger } from "../../logger";
import {
  normalizeRemoteDeviceConfig,
  projectMcpServerHealth,
  projectRemoteDeviceConfig,
  sanitizeMcpEndpoint,
  sanitizeMcpLogValue,
} from "../mcp/public_security";

function redactMcpArgumentList(value: unknown): string[] {
  const args = Array.isArray(value) ? value.map(item => String(item || '')) : [];
  const secretFlag = /^(?:--?(?:api[-_]?key|token|secret|password|authorization)|bearer)$/i;
  return args.map((arg, index) => {
    if (index > 0 && secretFlag.test(args[index - 1])) return '[configured]';
    if (/^(?:bearer\s+|sk-)[a-z0-9._~+/=-]{8,}$/i.test(arg)) return '[configured]';
    if (/^(?:--?(?:api[-_]?key|token|secret|password|authorization))=.+$/i.test(arg)) {
      return `${arg.split('=', 1)[0]}=[configured]`;
    }
    return arg;
  });
}

function publicMcpConfig(name: string, cfg: any, connected: boolean) {
  const {
    env: _env,
    headers: _headers,
    cachedTools: _cachedTools,
    ...safe
  } = cfg || {};
  return {
    name,
    ...safe,
    args: redactMcpArgumentList(cfg?.args),
    ...(cfg?.url ? { url: sanitizeMcpEndpoint(cfg.url) } : {}),
    envConfigured: Boolean(cfg?.env && Object.keys(cfg.env).length),
    headersConfigured: Boolean(cfg?.headers && Object.keys(cfg.headers).length),
    connected,
  };
}

function reportMcpRouteFailure(operation: string, error: unknown): void {
  logger.error(`[MCP Routes] ${operation} failed: ${sanitizeMcpLogValue((error as any)?.message || error)}`);
}

export function mountMcpRoutes(router: Router) {
  router.get("/mcp", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    const config = getMCPConfig();
    const connected = mcpManager.getConnectedServers();
    const servers = Object.entries(config).map(([name, cfg]) => (
      publicMcpConfig(name, cfg, connected.includes(name))
    ));
    res.json({ servers });
  });

  router.post("/mcp", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const { servers } = req.body;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        return res.status(400).json({ error: 'Invalid servers config' });
      }
      const registered = await updateMCPConfig({ ...getMCPConfig(), ...servers });
      res.json({ registered, count: registered.length });
    } catch (err: any) {
      reportMcpRouteFailure('configuration update', err);
      res.status(500).json({ error: 'MCP configuration update failed' });
    }
  });

  router.get("/mcp/health", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    res.json({ servers: projectMcpServerHealth(mcpManager.getServerHealth()) });
  });

  router.post("/mcp/restart/:name", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const tools = await mcpManager.restartServer(req.params.name);
      const registered = await recoverServerTools(req.params.name, tools);
      res.json({ tools, registered });
    } catch (err: any) {
      reportMcpRouteFailure('server restart', err);
      res.status(500).json({ error: 'MCP server restart failed' });
    }
  });

  router.get("/remote-devices", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    try {
      res.json({ devices: projectRemoteDeviceConfig(mcpManager.getRemoteDevices()) });
    } catch (err: any) {
      reportMcpRouteFailure('remote device read', err);
      res.status(500).json({ error: 'Remote device configuration could not be loaded' });
    }
  });

  router.put("/remote-devices", requireAuth, requireAdmin, requireLocalRequest, (req, res) => {
    try {
      const { devices } = req.body;
      const normalized = normalizeRemoteDeviceConfig(devices);
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid devices config' });
      }
      mcpManager.saveRemoteDevices(normalized);
      res.json({ success: true, devices: projectRemoteDeviceConfig(normalized) });
    } catch (err: any) {
      reportMcpRouteFailure('remote device update', err);
      res.status(500).json({ error: 'Remote device configuration could not be saved' });
    }
  });

  router.get("/mcp/github/search", requireAuth, async (req, res) => {
    try {
      const q = (req.query.q as string) || 'MCP server';
      const response = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+topic:mcp&sort=stars&order=desc&per_page=20`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'LumiCore-MCP-Browser',
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
          },
        }
      );
      if (!response.ok) {
        return res.status(response.status).json({ error: `GitHub API error: ${response.statusText}` });
      }
      const data = await response.json();
      const results = (data.items || []).map((item: any) => ({
        id: item.id,
        name: item.full_name,
        description: item.description,
        stars: item.stargazers_count,
        url: item.html_url,
        topics: item.topics || [],
        language: item.language,
        updatedAt: item.updated_at,
      }));
      res.json({ results, total: data.total_count || 0 });
    } catch (err: any) {
      reportMcpRouteFailure('GitHub search', err);
      res.status(500).json({ error: 'GitHub MCP search failed' });
    }
  });

  router.get("/mcp/npm/search", requireAuth, async (req, res) => {
    try {
      const q = (req.query.q as string) || 'mcp';
      const response = await fetch(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}+keywords:mcp&size=20`,
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'LumiCore-MCP-Browser',
          },
        }
      );
      if (!response.ok) {
        return res.status(response.status).json({ error: `npm API error: ${response.statusText}` });
      }
      const data = await response.json();
      const results = (data.objects || []).map((obj: any) => {
        const pkg = obj.package || {};
        return {
          id: pkg.name,
          name: pkg.name,
          description: pkg.description || '',
          stars: 0,
          url: pkg.links?.npm || `https://www.npmjs.com/package/${pkg.name}`,
          topics: pkg.keywords || [],
          language: 'npm',
          updatedAt: pkg.date || '',
        };
      });
      res.json({ results, total: data.total || 0 });
    } catch (err: any) {
      reportMcpRouteFailure('npm search', err);
      res.status(500).json({ error: 'npm MCP search failed' });
    }
  });
}
