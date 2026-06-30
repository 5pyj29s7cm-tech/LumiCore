import { readDB, writeDB } from '../../db_layer';
import { randomUUID } from 'crypto';
import type { SubscriptionActivationRequest, UserSubscription, SubscriptionPlan } from './types';
import { getPlan, getDefaultPlan } from './types';

export function getSubscription(userId: string): UserSubscription {
  const db = readDB();
  if (!db.subscriptions) db.subscriptions = [];

  let sub = db.subscriptions.find((s: any) => s.userId === userId);
  if (!sub) {
    const defaultPlan = getDefaultPlan();
    sub = {
      userId,
      planId: 'free',
      status: 'active',
      tokensUsedThisMonth: 0,
      monthlyTokenCap: defaultPlan.monthlyTokens,
      startedAt: new Date().toISOString(),
      expiresAt: null,
      trialEndsAt: null,
      activatedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.subscriptions.push(sub);
    writeDB(db);
  }
  return sub;
}

export function getSubscriptionWithPlan(userId: string): { subscription: UserSubscription; plan: SubscriptionPlan } {
  const subscription = getSubscription(userId);
  const plan = getPlan(subscription.planId) || getDefaultPlan();
  return { subscription, plan };
}

export function setSubscription(userId: string, updates: Partial<UserSubscription>): UserSubscription {
  const db = readDB();
  if (!db.subscriptions) db.subscriptions = [];

  let sub = db.subscriptions.find((s: any) => s.userId === userId);
  if (!sub) {
    sub = {
      userId,
      planId: 'free',
      status: 'trial',
      tokensUsedThisMonth: 0,
      monthlyTokenCap: getDefaultPlan().monthlyTokens,
      startedAt: new Date().toISOString(),
      expiresAt: null,
      trialEndsAt: null,
      activatedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...updates,
    };
    db.subscriptions.push(sub);
  } else {
    Object.assign(sub, updates, { updatedAt: new Date().toISOString() });
  }
  writeDB(db);
  return sub;
}

export function addTokensUsed(userId: string, tokens: number): UserSubscription {
  const db = readDB();
  if (!db.subscriptions) db.subscriptions = [];

  let sub = db.subscriptions.find((s: any) => s.userId === userId);
  if (!sub) {
    sub = {
      userId,
      planId: 'free',
      status: 'active',
      tokensUsedThisMonth: tokens,
      monthlyTokenCap: getDefaultPlan().monthlyTokens,
      startedAt: new Date().toISOString(),
      expiresAt: null,
      trialEndsAt: null,
      activatedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.subscriptions.push(sub);
  } else {
    sub.tokensUsedThisMonth = (sub.tokensUsedThisMonth || 0) + tokens;
    sub.updatedAt = new Date().toISOString();
  }
  writeDB(db);
  return sub;
}

export function checkTokenLimit(userId: string): { allowed: boolean; used: number; cap: number; remaining: number } {
  const sub = getSubscription(userId);
  const plan = getPlan(sub.planId) || getDefaultPlan();
  const used = sub.tokensUsedThisMonth || 0;
  const cap = sub.monthlyTokenCap || plan.monthlyTokens;
  return { allowed: used < cap, used, cap, remaining: Math.max(0, cap - used) };
}

export function listAllSubscriptions(): UserSubscription[] {
  const db = readDB();
  return (db.subscriptions || []) as UserSubscription[];
}

export function createActivationRequest(input: {
  userId: string;
  planId: string;
  contact: string;
  note?: string;
}): SubscriptionActivationRequest {
  const db = readDB();
  if (!db.subscriptionActivationRequests) db.subscriptionActivationRequests = [];

  const now = new Date().toISOString();
  const request: SubscriptionActivationRequest = {
    id: `act_${randomUUID()}`,
    userId: input.userId,
    planId: input.planId,
    contact: input.contact,
    note: input.note || '',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  db.subscriptionActivationRequests.unshift(request);
  writeDB(db);
  return request;
}

export function listActivationRequests(userId?: string): SubscriptionActivationRequest[] {
  const db = readDB();
  const requests = (db.subscriptionActivationRequests || []) as SubscriptionActivationRequest[];
  return userId ? requests.filter((request) => request.userId === userId) : requests;
}
