import { Router } from "express";
import { requireAdmin, requireAuth, requireLocalRequest } from "../middleware/auth";
import { mcpManager, getMCPConfig, updateMCPConfig, recoverServerTools } from "../mcp";

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

function sanitizeMcpUrl(value: unknown): string | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:api[-_]?key|token|secret|password|authorization)/i.test(key)) {
        parsed.searchParams.set(key, '[configured]');
      }
    }
    return parsed.toString();
  } catch {
    return '[configured endpoint]';
  }
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
    ...(cfg?.url ? { url: sanitizeMcpUrl(cfg.url) } : {}),
    envConfigured: Boolean(cfg?.env && Object.keys(cfg.env).length),
    headersConfigured: Boolean(cfg?.headers && Object.keys(cfg.headers).length),
    connected,
  };
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
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/mcp/health", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    res.json({ servers: mcpManager.getServerHealth() });
  });

  router.post("/mcp/restart/:name", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const tools = await mcpManager.restartServer(req.params.name);
      const registered = await recoverServerTools(req.params.name, tools);
      res.json({ tools, registered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/remote-devices", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    try {
      res.json({ devices: mcpManager.getRemoteDevices() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/remote-devices", requireAuth, requireAdmin, requireLocalRequest, (req, res) => {
    try {
      const { devices } = req.body;
      if (!devices || typeof devices !== 'object') {
        return res.status(400).json({ error: 'Invalid devices config' });
      }
      mcpManager.saveRemoteDevices(devices);
      res.json({ success: true, devices });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
            'User-Agent': 'LumiOS-MCP-Browser',
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
      res.status(500).json({ error: err.message });
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
            'User-Agent': 'LumiOS-MCP-Browser',
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
      res.status(500).json({ error: err.message });
    }
  });
}
