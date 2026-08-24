export type IssueSeverity = "blocks music" | "breaks flow" | "annoyance";
export type IssueRoute = { description: string; severity: IssueSeverity };

/** Explicit local route only; ordinary creative asks remain eligible for Moshi. */
export function matchIssueReport(text: string): IssueRoute | null {
  const match = text.trim().match(/^(?:please\s+)?(?:report\s+(?:a\s+)?bug|log\s+(?:an?\s+)?issue|report\s+(?:an?\s+)?issue)\b[\s:,-]*(.*)$/i);
  if (!match) return null;
  const description = (match[1] || "Issue reported without a description").trim();
  const lower = description.toLowerCase();
  const severity: IssueSeverity = /crash|cannot\s+(?:play|record|save)|can't\s+(?:play|record|save)|no\s+audio|blocks?\s+(?:me|music)/.test(lower)
    ? "blocks music"
    : /breaks?\s+(?:my\s+)?flow|stuck|freeze|unresponsive|have\s+to\s+restart/.test(lower)
      ? "breaks flow" : "annoyance";
  return { description, severity };
}
