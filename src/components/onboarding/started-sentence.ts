/**
 * Getting started's sentence after "N of M done." (src/guide/GettingStartedPage.tsx). M is the outcomes this role has
 * (five; an AE has four), the same count as the sidebar card, so the sentence names that number and says they tick
 * themselves (the deal contribution on a claim, or "I've claimed one").
 */
const WORD: Record<number, string> = { 3: 'Three', 4: 'Four', 5: 'Five' };

export function startedSentence(total: number): string {
  return `${WORD[total] ?? total} things and Command Center runs your day. Each one ticks itself from what you actually did.`;
}
