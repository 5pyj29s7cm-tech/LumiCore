import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { mcpManager, getMCPConfig, updateMCPConfig, recoverServerTools } from "../mcp";

export function mountMcpRoutes(router: Router) {
  router.get("/mcp", requireAuth, (_req, res) => {
    const config = getMCPConfig();
    const connected = mcpManager.getConnectedServers();
    const servers = Object.entries(config).map(([name, cfg]) => ({
      name,
      ...cfg,
      connected: connected.includes(name),
    }));
    res.json({ servers });
  });

  router.post("/mcp", requireAuth, async (req, res) => {
    try {
      const { servers } = req.body;
      if (!servers || typeof servers !== 'object') {
        return res.status(400).json({ error: 'Invalid servers config' });
      }
      const registered = await updateMCPConfig(servers);
      res.json({ registered, count: registered.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/mcp/health", (_req, res) => {
    res.json({ servers: mcpManager.getServerHealth() });
  });

  router.post("/mcp/restart/:name", async (req, res) => {
    try {
      const tools = await mcpManager.restartServer(req.params.name);
      const registered = await recoverServerTools(req.params.name, tools);
      res.json({ tools, registered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/remote-devices", (_req, res) => {
    try {
      res.json({ devices: mcpManager.getRemoteDevices() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/remote-devices", (req, res) => {
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

  router.get("/mcp/github/search", async (req, res) => {
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

  router.get("/mcp/npm/search", async (req, res) => {
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
