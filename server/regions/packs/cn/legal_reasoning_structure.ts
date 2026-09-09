/** Draft completeness only; never verifies facts, law, or the legal conclusion. */
export function inspectLegalReasoningStructure(text: string) {
  const labels = /(?:大前提|法律依据|major\s+premise|小前提|事实与证据|minor\s+premise|涵摄结论|适用结论|结论|conclusion)\s*[：:]/gi;
  const matches = [...String(text || '').matchAll(labels)];
  const sections = matches.map((match, index) => ({
    label: match[0],
    body: text.slice((match.index || 0) + match[0].length, matches[index + 1]?.index).trim(),
  })).filter(section => section.body.replace(/[\s#|*_\-]/g, '').length >= 12
    && !/^(?:\[?待(?:填写|补充|核验|检索|确认)|未提供|无资料|TBD|TODO)/i.test(section.body));
  const hasMajorPremise = sections.some(section => /大前提|法律依据|major/i.test(section.label));
  const hasMinorPremise = sections.some(section => /小前提|事实与证据|minor/i.test(section.label));
  const hasConclusion = sections.some(section => /结论|conclusion/i.test(section.label));
  return { passed: hasMajorPremise && hasMinorPremise && hasConclusion, hasMajorPremise, hasMinorPremise, hasConclusion, legalValidityVerified: false as const };
}
