import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';

describe('industry-aware autonomous learning', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('builds learning context from profession profiles, habits, and industry tasks', async () => {
    const { readDB, writeDB } = await import('../db_layer');
    const { formatIndustryLearningContext, getIndustryLearningProfiles } = await import('../server/autonomy/industry_learning');
    const userId = 'industry_learning_user';
    const db = readDB();

    db.professionProfiles = [{
      profession: 'lawyer',
      confidence: 0.82,
      evidence: ['中国裁判文书网', '企查查', 'Adobe Acrobat'],
      knowledgeDomains: ['民法', '诉讼法', '法律检索'],
      personaHints: ['逻辑严密'],
      installedRelevantTools: ['中国裁判文书网', '企查查'],
    }];
    db.memories = [
      ...(db.memories || []),
      {
        id: 'habit_legal_delivery',
        userId,
        type: 'habit',
        content: '用户做法律工作时要求先走三段论，再核验现行有效法律和类案来源。',
        keywords: '[]',
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    db.workTakeoverTasks = [{
      id: 'task_legal_case',
      userId,
      category: 'legal_case',
      title: '生成起诉状和证据目录',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        industryParameters: {
          summaryLines: ['案由：买卖合同纠纷', '证据：合同、聊天记录、转账流水'],
          expectedSurfaces: ['法院立案网', 'WPS/文档'],
        },
      },
    }];
    writeDB(db);

    const profiles = getIndustryLearningProfiles(userId);
    const context = formatIndustryLearningContext(userId) || '';

    expect(profiles[0].industry).toBe('legal_casework');
    expect(profiles[0].researchPriorities.join('\n')).toContain('现行有效法律');
    expect(context).toContain('使用者行业习惯画像');
    expect(context).toContain('legal_casework');
    expect(context).toContain('三段论');
    expect(context).toContain('诉讼文书交付包');
    expect(context).toContain('行业学习要求');
  });
});
