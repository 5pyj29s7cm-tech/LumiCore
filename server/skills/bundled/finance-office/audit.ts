export const FINANCE_CALCULATION_POLICY = Object.freeze({
  engine: 'decimal.js',
  monetaryScale: 2,
  rounding: 'ROUND_HALF_UP',
  numericInput: 'JSON number or base-10 decimal string',
});

export interface FinanceAuditReceipt {
  tool: string;
  skillVersion: string;
  generatedAt: string;
  sourceBasis: 'user_provided_inputs';
  inputFields: string[];
  calculationPolicy: typeof FINANCE_CALCULATION_POLICY;
  reviewRequired: true;
  limitations: string[];
}

function hasSuppliedValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function createFinanceAuditReceipt(
  tool: string,
  args: Record<string, unknown>,
  generatedAt = new Date(),
): FinanceAuditReceipt {
  return {
    tool,
    skillVersion: '1.5.0',
    generatedAt: generatedAt.toISOString(),
    sourceBasis: 'user_provided_inputs',
    inputFields: Object.entries(args)
      .filter(([key, value]) => !key.startsWith('_') && hasSuppliedValue(value))
      .map(([key]) => key)
      .sort(),
    calculationPolicy: FINANCE_CALCULATION_POLICY,
    reviewRequired: true,
    limitations: [
      'No ledger, invoice, tax authority, bank, or market source was independently verified by this calculation.',
      'External reporting, filing, payment, and investment decisions require accountable human review.',
    ],
  };
}

export function withFinanceAuditReceipt<T extends Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown>,
  result: T,
  generatedAt?: Date,
): T & { auditReceipt: FinanceAuditReceipt } {
  return {
    ...result,
    auditReceipt: createFinanceAuditReceipt(tool, args, generatedAt),
  };
}
