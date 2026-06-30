import { Router } from 'express';
import * as jwt from 'jsonwebtoken';
import { readDB } from '../../db_layer';
import {
  createActivationRequest,
  getSubscriptionWithPlan,
  listActivationRequests,
  setSubscription,
  addTokensUsed,
  checkTokenLimit,
  listAllSubscriptions,
} from './db';
import { PLANS, getPlan } from './types';
import type { CommercialReleaseInfo } from './types';

const router = Router();

// Helper: extract user ID from JWT
function getUserId(req: any): string {
  try {
    let token = req.cookies?.token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7);
    }
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'lumiOS_default_jwt_secret_2026_local') as jwt.JwtPayload;
      if (typeof decoded?.uid === 'string') return decoded.uid;
    }
  } catch {}
  return 'anonymous';
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function getCommercialReleaseInfo(): CommercialReleaseInfo {
  const websiteUrl = normalizeUrl(process.env.LUMI_OFFICIAL_URL || 'https://lumiai.asia');
  const billingMode: CommercialReleaseInfo['billingMode'] = process.env.LUMI_BILLING_MODE === 'online-checkout'
    ? 'online-checkout'
    : process.env.LUMI_BILLING_MODE === 'free-download'
      ? 'free-download'
      : 'manual-activation';
  const channel: CommercialReleaseInfo['channel'] = process.env.LUMI_RELEASE_CHANNEL === 'public-free'
    ? 'public-free'
    : process.env.LUMI_RELEASE_CHANNEL === 'internal'
      ? 'internal'
      : 'private-paid';

  return {
    appName: 'Lumi OS',
    version: process.env.LUMI_APP_VERSION || '3.0.0',
    channel,
    websiteUrl,
    downloadUrl: process.env.LUMI_DOWNLOAD_URL || `${websiteUrl}/download`,
    supportEmail: process.env.LUMI_SUPPORT_EMAIL || '3565286431@qq.com',
    salesContact: process.env.LUMI_SALES_CONTACT || 'Cap_William',
    billingMode,
    publicDownloadPlanned: process.env.LUMI_PUBLIC_DOWNLOAD_PLANNED !== '0',
    headline: 'Private paid preview before the official website launch.',
    note: 'Free users can keep using the core local experience. Paid plans unlock higher quotas, voice cloning, priority model access, and team features.',
    freeBoundary: [
      'Core chat and local memory',
      'Basic voice input/output',
      'One personal agent',
      'Community preview features from the public branch',
    ],
    paidBoundary: [
      'Higher monthly token quota',
      'Voice cloning and avatar studio priority features',
      'Advanced model/provider access',
      'Multiple agents, team workspace, and priority support',
    ],
  };
}

// ── GET /subscription/status — current user's plan and usage ──
router.get('/subscription/status', (req, res) => {
  try {
    const userId = getUserId(req);
    const { subscription, plan } = getSubscriptionWithPlan(userId);
    const limit = checkTokenLimit(userId);

    res.json({
      subscription: {
        userId: subscription.userId,
        planId: subscription.planId,
        status: subscription.status,
        tokensUsedThisMonth: subscription.tokensUsedThisMonth,
        monthlyTokenCap: subscription.monthlyTokenCap,
        startedAt: subscription.startedAt,
        expiresAt: subscription.expiresAt,
        trialEndsAt: subscription.trialEndsAt,
      },
      plan,
      usage: limit,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /subscription/plans — list all available plans ──
router.get('/subscription/plans', (_req, res) => {
  res.json({ plans: Object.values(PLANS) });
});

// ── GET /subscription/release-info — commercial release metadata ──
router.get('/subscription/release-info', (_req, res) => {
  res.json(getCommercialReleaseInfo());
});

// ── POST /subscription/activation-requests — request paid activation ──
router.post('/subscription/activation-requests', (req, res) => {
  try {
    const userId = getUserId(req);
    const planId = String(req.body?.planId || '').trim();
    const contact = String(req.body?.contact || '').trim();
    const note = String(req.body?.note || '').trim();

    if (!planId || !getPlan(planId)) return res.status(400).json({ error: 'Invalid plan ID' });
    if (!contact) return res.status(400).json({ error: 'Contact is required' });

    const request = createActivationRequest({ userId, planId, contact, note });
    res.json({ success: true, request });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /subscription/activation-requests — current user's requests ──
router.get('/subscription/activation-requests', (req, res) => {
  try {
    const userId = getUserId(req);
    res.json({ requests: listActivationRequests(userId) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /subscription/activate — admin: activate/change user plan ──
router.post('/subscription/activate', (req, res) => {
  try {
    const adminId = getUserId(req);
    // Admin role check
    const db = readDB();
    const adminUser = db.users.find((u: any) => u.uid === adminId);
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { userId, planId, status, trialDays } = req.body;

    if (!userId || !planId) {
      return res.status(400).json({ error: 'userId and planId required' });
    }

    const plan = getPlan(planId);
    if (!plan) return res.status(400).json({ error: 'Invalid plan ID' });

    const updates: any = {
      planId,
      status: status || 'active',
      monthlyTokenCap: plan.monthlyTokens,
      activatedBy: adminId,
      startedAt: new Date().toISOString(),
    };

    if (trialDays) {
      updates.status = 'trial';
      updates.trialEndsAt = new Date(Date.now() + trialDays * 86400000).toISOString();
    }

    const sub = setSubscription(userId, updates);
    res.json({ success: true, subscription: sub, plan });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /subscription/admin — admin: list all subscriptions ──
router.get('/subscription/admin', (req, res) => {
  try {
    const adminId = getUserId(req);
    const db = readDB();
    const adminUser = db.users.find((u: any) => u.uid === adminId);
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const all = listAllSubscriptions();
    const enriched = all.map(sub => ({
      ...sub,
      plan: getPlan(sub.planId) || null,
      usagePercent: sub.monthlyTokenCap > 0
        ? Math.round((sub.tokensUsedThisMonth / sub.monthlyTokenCap) * 100)
        : 0,
    }));
    res.json({ subscriptions: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /subscription/admin/activation-requests — admin: list activation requests ──
router.get('/subscription/admin/activation-requests', (req, res) => {
  try {
    const adminId = getUserId(req);
    const db = readDB();
    const adminUser = db.users.find((u: any) => u.uid === adminId);
    if (!adminUser || adminUser.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    res.json({ requests: listActivationRequests() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /subscription/tokens — proxy: record token usage ──
router.post('/subscription/tokens', (req, res) => {
  try {
    const userId = getUserId(req);
    const { tokens } = req.body;
    if (!tokens || typeof tokens !== 'number') {
      return res.status(400).json({ error: 'tokens (number) required' });
    }

    const { allowed, used, cap, remaining } = checkTokenLimit(userId);
    if (!allowed) {
      return res.status(429).json({ error: 'Token limit exceeded', used, cap, remaining: 0 });
    }

    const sub = addTokensUsed(userId, tokens);
    res.json({
      allowed: true,
      used: sub.tokensUsedThisMonth,
      cap: sub.monthlyTokenCap,
      remaining: Math.max(0, sub.monthlyTokenCap - sub.tokensUsedThisMonth),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export { router as subscriptionRoutes, getUserId };
