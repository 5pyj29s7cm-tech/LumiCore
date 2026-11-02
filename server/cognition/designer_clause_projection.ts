import { affirmativeActionInstructionClauses } from './action_instruction_clauses';

/** Keep a direct coordinated design operand together without crossing a veto or sentence. */
export function affirmativeDesignerInstructionText(text: string): string {
  const clauses = affirmativeActionInstructionClauses(text);
  let result = '';
  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index];
    const previous = clauses[index - 1];
    // i18n-allow: Exact unquoted coordination grammar; never an authorization predicate.
    const adjacent = previous && previous.start + previous.text.length === clause.start
      && /(?:并且|然后|接着|并|\band(?:\s+then)?|\bthen|\bafterwards)\s*$/iu.test(previous.text);
    result += (index ? adjacent ? ' ' : '\n' : '') + clause.probe;
  }
  return result;
}
