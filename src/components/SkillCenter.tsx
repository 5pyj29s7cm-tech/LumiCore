import { useSkillCenterState } from './skill_center/useSkillCenterState';
import { renderSkillCenter } from './skill_center/view';

export type { SkillCenterTab } from './skill_center/contracts';

export function SkillCenter(props: Parameters<typeof useSkillCenterState>[0]) {
  return renderSkillCenter(useSkillCenterState(props));
}
