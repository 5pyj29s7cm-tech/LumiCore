import { Router } from 'express';
import { requireAuth, resolveDomain } from '../middleware/auth';
import { listExternalAiSessionSnapshots } from '../agents/external_ai_collaboration';
import { fetchCommunityLumiDirectory } from '../lap/community_directory';

export const commandCenterRoutes = Router();

commandCenterRoutes.get('/command-center/external-ai-sessions', requireAuth, (req, res) => {
  const scope = resolveDomain(req.user!);
  const sessions = listExternalAiSessionSnapshots({
    userId: req.user!.uid,
    domain: scope.domain,
    orgId: scope.orgId,
    limit: Number(req.query.limit) || 12,
  });
  res.json({ sessions, count: sessions.length, scope });
});

commandCenterRoutes.get('/command-center/community-lumi', requireAuth, async (req, res) => {
  const snapshot = await fetchCommunityLumiDirectory(Number(req.query.limit) || 24);
  res.status(snapshot.status === 'invalid_configuration' ? 503 : 200).json(snapshot);
});
