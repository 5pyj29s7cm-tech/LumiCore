import { describe, expect, it } from 'vitest';
import { buildInterviewPlan, buildJobDescription, summarizeResumeFit } from '../server/skills/bundled/hr-recruiting/logic';
import { draftFollowUp, reviewCustomerHealth, scoreLead, triageSupportTickets } from '../server/skills/bundled/sales-customer-ops/logic';
import { analyzeMenuMargin, analyzePromotionRoi, analyzeWaste } from '../server/skills/bundled/restaurant-store-ops/logic';

describe('hr recruiting skill logic', () => {
  it('builds fair job descriptions and structured interview plans', () => {
    const jd = buildJobDescription({
      role: 'Frontend Engineer',
      team: 'Product',
      responsibilities: ['Build UI workflows'],
      requirements: ['React', 'TypeScript'],
    });
    const plan = buildInterviewPlan({
      role: 'Frontend Engineer',
      competencies: ['React depth', 'Product thinking'],
    });

    expect(jd.jd.requirements).toEqual(['React', 'TypeScript']);
    expect(jd.fairnessChecks[0]).toContain('protected-class');
    expect(plan.plan).toHaveLength(2);
  });

  it('summarizes resume fit against requirements', () => {
    const fit = summarizeResumeFit({
      resumeText: 'Built React dashboards. Owned TypeScript migration. Improved performance.',
      roleRequirements: ['React', 'TypeScript', 'GraphQL'],
    });

    expect(fit.matchCount).toBe(2);
    expect(fit.concernsToCheck[0]).toContain('GraphQL');
    expect(fit.strengths.length).toBeGreaterThan(0);
  });
});

describe('sales and customer operations skill logic', () => {
  it('scores hot leads from intent signals', () => {
    const lead = scoreLead({
      leadText: 'Boss is decision maker, has budget, wants demo this week with a deadline to solve efficiency pain.',
      product: 'Lumi',
    });

    expect(lead.score).toBeGreaterThanOrEqual(75);
    expect(lead.grade).toBe('hot');
    expect(lead.signals.demoIntent).toBe(true);
  });

  it('grounds multilingual lead qualification in supplied facts', () => {
    const englishLead = scoreLead({
      leadText: 'The customer confirmed a 200,000 CNY budget, the decision maker joins Friday, and they requested a formal proposal next week.',
      product: 'Renovation service',
    });
    const chineseLead = scoreLead({
      leadText: '\u5ba2\u6237\u5df2\u786e\u8ba4\u9884\u7b9720\u4e07\uff0c\u51b3\u7b56\u4eba\u5468\u4e94\u53c2\u52a0\u4f1a\u8bae\uff0c\u8981\u6c42\u4e0b\u5468\u63d0\u4ea4\u6b63\u5f0f\u65b9\u6848\u3002',
      product: '\u88c5\u4fee\u670d\u52a1',
    });

    for (const lead of [englishLead, chineseLead]) {
      expect(lead.grade).toBe('hot');
      expect(lead.score).toBeGreaterThanOrEqual(75);
      expect(lead.signals).toMatchObject({
        budget: true,
        timing: true,
        decisionMaker: true,
        buyingIntent: true,
      });
      expect(lead.inputGrounded).toBe(true);
    }
  });

  it('does not manufacture a customer follow-up without source context', () => {
    const draft = draftFollowUp({ customerName: 'Acme', context: '', goal: 'Book a call' });

    expect(draft.message).toBe('');
    expect(draft.completionEligible).toBe(false);
    expect(draft.missingInputs).toContain('context');
  });

  it('reviews customer health and triages support tickets', () => {
    const health = reviewCustomerHealth({
      customerText: 'Acme active renewal expansion\nBeta churn risk complaint ticket',
    });
    const triage = triageSupportTickets({
      ticketText: 'Cannot use login, system down\nNeed invoice copy',
    });

    expect(health.atRiskCustomers).toEqual(expect.arrayContaining(['Beta churn risk complaint ticket']));
    expect(triage.highPriorityCount).toBe(1);
    expect(triage.routingSummary.account).toBe(1);
    expect(triage.routingSummary.billing).toBe(1);
  });
});

describe('restaurant and store operations skill logic', () => {
  it('calculates menu margin and waste value', () => {
    const margin = analyzeMenuMargin({
      menuText: 'Latte price 28 cost 9 sales 100\nCake price 20 cost 14 sales 20',
    });
    const waste = analyzeWaste({
      wasteText: 'Milk waste 6 unitCost 12 sold 80',
    });

    expect(margin.totalGrossProfit).toBe(2020);
    expect(margin.reviewItems).toEqual(['Cake price 20 cost 14 sales 20']);
    expect(waste.totalWasteValue).toBe(72);
    expect(waste.rows[0].wasteRate).toBe(6.98);
  });

  it('flags loss-making promotions', () => {
    const promo = analyzePromotionRoi({
      promotionText: 'Weekend set revenue 1000 discount 700 ad 100 orders 60',
      grossMarginRate: 0.5,
    });

    expect(promo.rows[0].contribution).toBe(-300);
    expect(promo.warnings[0]).toContain('negative');
  });
});
