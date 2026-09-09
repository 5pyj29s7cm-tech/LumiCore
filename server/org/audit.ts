/**
 * Org Audit — query, filter, export, statistics.
 *
 * Low-level logAudit / listAuditLog live in db.ts.
 * This module adds filtering, date-range queries, and CSV export.
 */

import * as EDB from './db';

// ── Query with filters ──────────────────────────────────────────────────

export interface AuditFilter {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: string;   // ISO date
  to?: string;     // ISO date
}

export function queryAuditLog(
  orgId: string,
  filters: AuditFilter = {},
  limit: number = 50,
  offset: number = 0
): EDB.AuditEntry[] {
  let entries = EDB.listAuditLog(orgId, null, 0); // explicit unbounded query, then filter

  if (filters.userId) {
    entries = entries.filter(e => e.userId === filters.userId);
  }
  if (filters.action) {
    entries = entries.filter(e => e.action === filters.action);
  }
  if (filters.resourceType) {
    entries = entries.filter(e => e.resourceType === filters.resourceType);
  }
  if (filters.resourceId) {
    entries = entries.filter(e => e.resourceId === filters.resourceId);
  }
  if (filters.from) {
    entries = entries.filter(e => e.timestamp >= filters.from!);
  }
  if (filters.to) {
    entries = entries.filter(e => e.timestamp <= filters.to!);
  }

  return entries.slice(offset, offset + limit);
}

// ── Statistics ──────────────────────────────────────────────────────────

export interface AuditStats {
  totalEntries: number;
  topActions: Array<{ action: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  actionsByDay: Array<{ date: string; count: number }>;
  recentActivity: EDB.AuditEntry[];
}

export function getAuditStats(orgId: string, daysBack: number = 7): AuditStats {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const entries = EDB.listAuditLog(orgId, null, 0).filter(e => e.timestamp >= since);

  // Top actions
  const actionCounts = new Map<string, number>();
  // Top users
  const userCounts = new Map<string, number>();
  // By day
  const dayCounts = new Map<string, number>();

  for (const e of entries) {
    actionCounts.set(e.action, (actionCounts.get(e.action) || 0) + 1);
    userCounts.set(e.userId, (userCounts.get(e.userId) || 0) + 1);
    const day = e.timestamp.slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
  }

  const topActions = [...actionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([action, count]) => ({ action, count }));

  const topUsers = [...userCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([userId, count]) => ({ userId, count }));

  const actionsByDay = [...dayCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  return {
    totalEntries: entries.length,
    topActions,
    topUsers,
    actionsByDay,
    recentActivity: entries.slice(0, 20),
  };
}

// ── CSV Export ──────────────────────────────────────────────────────────

export function exportAuditCSV(orgId: string, filters: AuditFilter = {}): string {
  const entries = queryAuditLog(orgId, filters, 10000, 0);

  const header = ['timestamp', 'userId', 'action', 'resourceType', 'resourceId', 'details'].join(',');
  const rows = entries.map(e => {
    const details = (e.details || '').replace(/"/g, '""');
    return [e.timestamp, e.userId, e.action, e.resourceType, e.resourceId, `"${details}"`].join(',');
  });

  return [header, ...rows].join('\n');
}
