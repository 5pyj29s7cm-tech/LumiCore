import { readDB } from '../../db_layer';
import { addMemory } from './store';

export interface BehavioralPattern {
  type: 'active_hours' | 'frequent_tool' | 'topic_cluster' | 'session_pattern';
  content: string;
  confidence: number;
}

/**
 * Analyze interaction history for behavioral patterns without LLM.
 * Extracts: active hours, frequently used tools, topic clusters, session patterns.
 * Called periodically by the scheduler when observer mode is active.
 */
export function analyzeBehavioralPatterns(userId: string, domain = 'personal', orgId = ''): BehavioralPattern[] {
  const db = readDB();
  const interactions = (db.interactions || []).filter((i: any) => {
    if ((i.domain || 'personal') !== domain || (i.orgId || '') !== orgId) return false;
    // Filter to a specific user if userId is provided
    if (userId && userId !== 'anonymous') return i.userId === userId;
    // For anonymous, use last 100 interactions
    return true;
  }).slice(-100);

  if (interactions.length < 10) return [];

  const patterns: BehavioralPattern[] = [];

  // 1. Active hours analysis
  const hourCounts = new Map<number, number>();
  for (const i of interactions) {
    if (i.timestamp) {
      const hour = new Date(i.timestamp).getHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }
  }
  if (hourCounts.size > 0) {
    const sortedHours = [...hourCounts.entries()].sort((a, b) => b[1] - a[1]);
    const peakHours = sortedHours.slice(0, 2).map(([h]) => h);
    const totalInteractions = interactions.length;
    const peakPercentage = ((sortedHours[0][1] / totalInteractions) * 100).toFixed(0);
    patterns.push({
      type: 'active_hours',
      content: `User is most active during hours ${peakHours.join(':00 and ')}:00 (${peakPercentage}% of interactions)`,
      confidence: Math.min(0.8, sortedHours[0][1] / totalInteractions + 0.2),
    });
  }

  // 2. Frequent tool usage
  const toolCounts = new Map<string, number>();
  for (const i of interactions) {
    if (i.toolCalls) {
      for (const tc of i.toolCalls) {
        const name = tc.name || tc;
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      }
    }
  }
  if (toolCounts.size > 0) {
    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const toolList = topTools.map(([name, count]) => `${name}(${count}x)`).join(', ');
    patterns.push({
      type: 'frequent_tool',
      content: `Most used tools: ${toolList}`,
      confidence: Math.min(0.7, topTools[0][1] / interactions.length + 0.3),
    });
  }

  // 3. Topic clusters from interaction content keywords
  const wordFreq = new Map<string, number>();
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
    'about', 'like', 'through', 'after', 'over', 'between', 'out', 'just', 'not', 'no', 'yes',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', '这些', '那些',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好']);
  for (const i of interactions) {
    if (i.content) {
      const words = i.content.toLowerCase().split(/\s+/);
      for (const w of words) {
        const clean = w.replace(/[^a-z一-鿿㐀-䶿]/g, '');
        if (clean.length >= 2 && !stopWords.has(clean)) {
          wordFreq.set(clean, (wordFreq.get(clean) || 0) + 1);
        }
      }
    }
  }
  const sortedWords = [...wordFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (sortedWords.length >= 3) {
    const clusters = sortedWords.map(([w]) => w).join(', ');
    patterns.push({
      type: 'topic_cluster',
      content: `Common topics/terms: ${clusters}`,
      confidence: Math.min(0.6, sortedWords.length / 10 + 0.2),
    });
  }

  // 4. Session pattern
  const sessionLengths: number[] = [];
  const dates = new Set<string>();
  for (const i of interactions) {
    if (i.timestamp) {
      dates.add(i.timestamp.slice(0, 10));
    }
  }
  const avgPerDay = interactions.length / Math.max(1, dates.size);
  if (dates.size >= 3) {
    patterns.push({
      type: 'session_pattern',
      content: `Average of ${avgPerDay.toFixed(1)} interactions per active day across ${dates.size} days`,
      confidence: Math.min(0.7, dates.size / 10 + 0.3),
    });
  }

  return patterns.filter(p => p.confidence >= 0.3);
}

/**
 * Run behavioral analysis and save patterns as habit-type memories.
 * Returns the number of new patterns found.
 */
export function runBehavioralAnalysis(userId: string = 'anonymous', domain = 'personal', orgId = ''): number {
  const patterns = analyzeBehavioralPatterns(userId, domain, orgId);
  let saved = 0;

  for (const pattern of patterns) {
    const keywords = pattern.type === 'topic_cluster'
      ? pattern.content.split(': ')[1]?.split(', ').slice(0, 5) || []
      : [pattern.type];

    try {
      addMemory({
        userId,
        type: 'habit',
        content: pattern.content,
        keywords,
        confidence: pattern.confidence,
        sourceInteractionId: `behavioral_${Date.now()}`,
      }, {
        domain,
        orgId,
        source: 'system',
        privacyClass: domain === 'work' ? 'organization' : 'private',
      });
      saved++;
    } catch {
      // memory may already exist or quota reached
    }
  }

  console.log(`[Behavioral] Analysis complete: ${saved} patterns saved for user ${userId}`);
  return saved;
}
