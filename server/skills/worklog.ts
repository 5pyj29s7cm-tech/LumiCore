/**
 * Workflow recorder — captures tool execution traces for pattern detection.
 * Keeps last 50 workflows in memory; the scheduler periodically checks
 * for repeatable patterns and triggers skill generation.
 */

export interface WorkflowStep {
  name: string;
  args: Record<string, any>;
  resultSummary: string;   // first 200 chars of tool result
}

export interface WorkflowRecord {
  id: string;
  userId: string;
  userIntent: string;       // LLM-summarized intent of the user's request
  toolSequence: WorkflowStep[];
  conversationExcerpt: string; // user's original message (for context)
  timestamp: string;
  domain?: string;
  orgId?: string;
}

const recentWorkflows: WorkflowRecord[] = [];
const MAX_WORKFLOWS = 50;

function generateId(): string {
  return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/** Record a completed tool execution workflow */
export function recordWorkflow(record: Omit<WorkflowRecord, 'id' | 'timestamp'>): WorkflowRecord {
  const entry: WorkflowRecord = {
    id: generateId(),
    ...record,
    domain: record.domain === 'work' ? 'work' : 'personal',
    orgId: record.domain === 'work' ? (record.orgId || '') : '',
    timestamp: new Date().toISOString(),
  };
  recentWorkflows.push(entry);
  if (recentWorkflows.length > MAX_WORKFLOWS) {
    recentWorkflows.shift();
  }
  console.log(`[Worklog] Recorded workflow "${record.userIntent.slice(0, 50)}" (${record.toolSequence.length} tools)`);
  return entry;
}

/** Get recent workflows (for pattern detection) */
export function getRecentWorkflows(userId?: string, domain?: string, orgId?: string): WorkflowRecord[] {
  return recentWorkflows.filter(w => {
    if (userId && w.userId !== userId) return false;
    if (domain !== undefined && (w.domain || 'personal') !== domain) return false;
    if (orgId !== undefined && (w.orgId || '') !== orgId) return false;
    return true;
  });
}

/** Clear all workflows */
export function clearWorkflows(): void {
  recentWorkflows.length = 0;
}

/** Remove specific workflows by ID */
export function removeWorkflows(ids: string[]): void {
  const idSet = new Set(ids);
  for (let i = recentWorkflows.length - 1; i >= 0; i--) {
    if (idSet.has(recentWorkflows[i].id)) {
      recentWorkflows.splice(i, 1);
    }
  }
}

/** Count how many workflows match a given intent (simple keyword overlap for now)
 * @deprecated Use findWorkflowClusters() for auto-generation; this remains for backward compat. */
export function countSimilarWorkflows(intent: string, threshold = 3): WorkflowRecord[] {
  const intentLower = intent.toLowerCase();
  const tokens = intentLower.split(/\s+/).filter(w => w.length > 2);

  const matches = recentWorkflows.filter(w => {
    const wLower = w.userIntent.toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      if (wLower.includes(t)) hits++;
    }
    return hits >= Math.min(2, tokens.length);
  });

  return matches.length >= threshold ? matches : [];
}

// ── Improved pattern detection ──

/**
 * Compute a multi-factor similarity score (0-1) between two workflow records.
 * Factors: tool sequence Jaccard overlap, intent text similarity (Levenshtein + TF-IDF),
 * and shared tool count ratio.
 */
function computeSimilarityScore(a: WorkflowRecord, b: WorkflowRecord): number {
  // Factor 1: Tool name Jaccard similarity (0-1)
  const aTools = new Set(a.toolSequence.map(s => s.name));
  const bTools = new Set(b.toolSequence.map(s => s.name));
  const intersection = new Set([...aTools].filter(t => bTools.has(t)));
  const union = new Set([...aTools, ...bTools]);
  const jaccard = union.size === 0 ? 0 : intersection.size / union.size;

  // Factor 2: Intent text similarity — take the max of Levenshtein and TF-IDF cosine
  const aText = a.userIntent.slice(0, 120).toLowerCase();
  const bText = b.userIntent.slice(0, 120).toLowerCase();

  // 2a: Levenshtein edit distance, normalized
  const maxLen = Math.max(aText.length, bText.length, 1);
  const levDist = levenshtein(aText, bText);
  const editSimilarity = 1 - (levDist / maxLen);

  // 2b: TF-IDF-style cosine similarity on weighted tokens
  const cosSim = cosineSimilarity(a.userIntent, b.userIntent);

  const textSimilarity = Math.max(editSimilarity, cosSim);

  // Factor 3: Shared tool count ratio
  const sharedRatio = Math.min(
    intersection.size / Math.max(aTools.size, bTools.size, 1),
    1,
  );

  // Weighted combination
  return jaccard * 0.35 + textSimilarity * 0.45 + sharedRatio * 0.20;
}

/** Levenshtein edit distance between two strings */
function levenshtein(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        s1[i - 1] === s2[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Cosine similarity on weighted token frequency vectors */
function cosineSimilarity(textA: string, textB: string): number {
  const tokenize = (s: string): Map<string, number> => {
    const tokens = s.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const tf: Map<string, number> = new Map();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    // Weight by word length (longer words carry more meaning)
    for (const [t, c] of tf) {
      tf.set(t, c * Math.min(t.length / 4, 1.5));
    }
    return tf;
  };

  const aTF = tokenize(textA);
  const bTF = tokenize(textB);
  let dotProduct = 0;
  let aNorm = 0;
  let bNorm = 0;
  const allTokens = new Set([...aTF.keys(), ...bTF.keys()]);
  for (const t of allTokens) {
    const av = aTF.get(t) || 0;
    const bv = bTF.get(t) || 0;
    dotProduct += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  const aNormSqrt = Math.sqrt(aNorm);
  const bNormSqrt = Math.sqrt(bNorm);
  return aNormSqrt === 0 || bNormSqrt === 0 ? 0 : dotProduct / (aNormSqrt * bNormSqrt);
}

export interface WorkflowCluster {
  representativeIntent: string;
  workflows: WorkflowRecord[];
  avgSimilarity: number;
}

/**
 * Find clusters of similar workflows in the recorded history.
 * Uses multi-factor similarity scoring with a minimum cluster size threshold.
 */
export function findWorkflowClusters(
  minSize: number = 3,
  userId?: string,
  domain?: string,
  orgId?: string,
): WorkflowCluster[] {
  const candidates = getRecentWorkflows(userId, domain, orgId);
  if (candidates.length < minSize) return [];

  const clusters: WorkflowCluster[] = [];
  const assigned = new Set<string>();

  for (const wf of candidates) {
    if (assigned.has(wf.id)) continue;
    const cluster: WorkflowRecord[] = [wf];
    for (const other of candidates) {
      if (other.id === wf.id || assigned.has(other.id)) continue;
      if (computeSimilarityScore(wf, other) > 0.35) {
        cluster.push(other);
      }
    }
    if (cluster.length >= minSize) {
      for (const c of cluster) assigned.add(c.id);
      // Average pairwise similarity within the cluster
      let totalSim = 0;
      let count = 0;
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          totalSim += computeSimilarityScore(cluster[i], cluster[j]);
          count++;
        }
      }
      clusters.push({
        representativeIntent: wf.userIntent,
        workflows: cluster,
        avgSimilarity: count > 0 ? totalSim / count : 1,
      });
    }
  }

  return clusters.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
}
