export function buildPixelPetDesignPrompt(prompt: string): string {
  return `You are a pixel-art pet designer for a desktop companion app. Given a Chinese or English description, output ONLY valid JSON (no markdown, no explanation) that describes a cute desktop pet.

User description: "${prompt}"

Output JSON fields:
- petName: short name (Chinese if input is Chinese, max 8 chars)
- species: "cat" | "fox" | "rabbit" | "bear" | "hamster" | "blob" | "bird" | "dragon"
- color: main body color — "white" | "black" | "red" | "blue" | "green" | "purple" | "pink" | "orange" | "yellow" | "brown" | "cream" | "grey"
- pattern: "solid" | "striped" | "spotted" | "bicolor" | "gradient"
- patternColor: secondary color for pattern (use color list above)
- eyeShape: "round" | "oval" | "slit" | "star" | "heart"
- eyeColor: eye color hex
- mouthStyle: "smile" | "open" | "shocked" | "neutral" | "tongue"
- size: "tiny" | "small" | "normal" | "large"
- hasWings: true/false
- hasHorns: true/false
- special: "none" | "glowing" | "sparkly"

Match species to description clues: 猫→cat, 狐狸/狐→fox, 兔→rabbit, 熊→bear, 仓鼠/鼠→hamster, 史莱姆/软泥→blob, 鸟→bird, 龙→dragon.
Choose pattern/eyeShape/mouthStyle that fits the described personality.
If the description doesn't specify, use reasonable defaults. Be creative!`;
}

export const CN_CREATIVE_PET_PATTERNS = {
  fox: /狐狸|fox/i,
  rabbit: /兔|rabbit|bunny/i,
  bear: /熊|bear/i,
  hamster: /仓鼠|hamster/i,
  blob: /史莱姆|blob|slime|软泥/i,
  bird: /鸟|bird/i,
  dragon: /龙|dragon/i,
  pattern: /条纹|stripe|斑点|spot|花纹/i,
  spotted: /斑点|spot/i,
  starEye: /星星|star|星眼/i,
  heartEye: /爱心|heart|心形/i,
  slitEye: /蛇眼|slit|竖瞳/i,
  openMouth: /张嘴|open|张大/i,
  shockedMouth: /惊讶|shock/i,
  tongueMouth: /吐舌|tongue/i,
  tiny: /tiny|小小|迷你|mini/i,
  small: /small|小/i,
  large: /large|大|big/i,
  wings: /wing|翅膀|fly/i,
  horns: /horn|角/i,
  glowing: /glow|发光|光/i,
  sparkly: /spark|星星|闪光|闪/i,
} as const;
