// Branch connection API — employee connects to company server
import { Router } from "express";
import { requireAdmin, requireAuth, requireLocalRequest } from "../middleware/auth";
import { connectToOrg, disconnectFromOrg, getBranchState, syncWorkData } from "../org/branch";

function publicBranchState() {
  const state: any = getBranchState();
  const { connectionToken, ...safeState } = state;
  return {
    ...safeState,
    connected: state.status === 'connected',
    tokenConfigured: Boolean(connectionToken),
  };
}

export function mountBranchConnectionRoutes(router: Router, _jwtSecret: string) {
  // Get current branch connection state
  router.get("/branch/state", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    try {
      res.json(publicBranchState());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Connect to org — employee joins a company
  router.post("/branch/connect", requireAuth, requireAdmin, requireLocalRequest, async (req, res) => {
    try {
      const orgId = String(req.body?.orgId || '').trim();
      const companyUrl = String(req.body?.companyUrl || '').trim().replace(/\/+$/, '');
      const token = String(req.body?.token || '').trim();
      if (!orgId || !companyUrl || !token) {
        return res.status(400).json({ error: 'orgId, companyUrl and token are required' });
      }
      const result = await connectToOrg(orgId, companyUrl, token);
      if (result.success) {
        res.json({ success: true, state: publicBranchState() });
      } else {
        res.status(400).json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Disconnect from org
  router.post("/branch/disconnect", requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
    try {
      disconnectFromOrg();
      res.json({ success: true, state: publicBranchState() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sync work data on demand
  router.post("/branch/sync", requireAuth, requireAdmin, requireLocalRequest, async (_req, res) => {
    try {
      const result = await syncWorkData();
      res.json({ ...result, state: publicBranchState() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
