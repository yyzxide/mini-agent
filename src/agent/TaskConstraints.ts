/**
 * Explicit user constraints are runtime boundaries, not intent routing hints.
 * They may use deterministic recognition because a missed read-only constraint
 * is a safety problem; positive task interpretation remains model-driven.
 */
export function hasExplicitReadOnlyConstraint(userGoal: string): boolean {
  const explicitConstraint = /(?:不要|别|无需|不需要|禁止).{0,24}(?:修改|改动|写入|写文件)|(?:只|仅).{0,12}(?:分析|解释|建议|代码片段)|\b(?:do not|don't|without|never)\b.{0,24}\b(?:edit|modify|write|change files?)\b|\b(?:analysis|advice|snippet)\s+only\b/i.test(userGoal);
  if (!explicitConstraint) return false;

  const negatesReadOnlyConstraint = /(?:不是|并非|不只是|不仅仅是).{0,12}(?:让你|要你)?(?:只|仅)?.{0,8}(?:分析|解释|建议|给代码片段)|\b(?:not|isn't|is not)\b.{0,16}\b(?:just|only)\b.{0,10}\b(?:analy[sz]e|explain|advise|give a snippet)\b/i.test(userGoal);
  return !negatesReadOnlyConstraint;
}
