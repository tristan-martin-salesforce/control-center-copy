/**
 * The D-100 test for the Assistant's two effects that are not item actions (SEC-8, SEC-9): does the user's own message
 * (its own words: quoted lines and fenced blocks are pasted text, not theirs) carry this? A tool result (Slack, Gmail,
 * Drive text) never reaches `input.text`, so a planted instruction cannot pass either test.
 *
 *   preferenceInUserWords  `remember {scope: preference}` keeps a pinned, every-thread preference only when the
 *                          message asks to keep one ("remember", "from now on", "always", "never", "I prefer" …) and
 *                          shares at least one of its words
 *   connectorNamed         `run reauth` opens a sign-in window only when the message asks to sign in (or says the
 *                          connection is broken) and names that connector: "summarise my unread mail" names gmail
 *                          but asks for no sign-in (P25-1)
 */
import { ownWords } from './router';

const norm = (t: string) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** The words that ask to keep a standing preference (in the user's own words). */
const KEEP = /\b(remember|keep in mind|from now on|going forward|in future|note that|make a note|my preference|i prefer|i'd rather|always|never)\b/;
const FILLER = new Set('the and for with from into about that this they them their your you user users when what which always never prefer remember please'.split(' '));
const contentWords = (t: string) => [...new Set(norm(t).trim().split(' ').filter((w) => w.length >= 3 && !FILLER.has(w)))];
/** "logs" and "log", "minutes" and "minute": one is a prefix of the other, three letters or more. */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

export function preferenceInUserWords(input: { text: string }, preference: string): boolean {
  const own = ownWords(input.text).toLowerCase();
  if (!KEEP.test(own)) return false;
  const mine = contentWords(own);
  const want = contentWords(preference);
  return want.length === 0 || want.some((w) => mine.some((m) => sameWord(w, m)));
}

/** The words a user uses for each connector (its id always counts). */
const CONNECTOR_WORDS: Readonly<Record<string, readonly string[]>> = {
  gmail: ['gmail', 'email', 'mail', 'inbox'],
  calendar: ['calendar', 'cal'],
  drive: ['drive', 'docs'],
  org62: ['org62', 'org 62', 'salesforce', 'sfdc'],
  vdp: ['vdp', 'okta'],
  claude: ['claude'],
};

/** The words that ask for a sign-in, or say the connection needs one (in the user's own words). */
const SIGN_IN = /\b((sign|log)(ging)? ?(me )?(back )?in|re-?auth\w*|re-?authenticate|authenticate|re-?log ?in|re-?login|re-?connect\w*|(cookie|token|session|login|sign-in)s? (has |have |is |are )?(expired|stale|dead)|expired|(stopped|not) syncing|isn'?t syncing|broken|fix (it|my|the))\b/;

export function connectorNamed(input: { text: string }, connector: string): boolean {
  const id = norm(connector).trim();
  if (!id) return false;
  const own = ownWords(input.text).toLowerCase();
  if (!SIGN_IN.test(own)) return false;
  const text = norm(own);
  return [id, ...(CONNECTOR_WORDS[id] ?? [])].some((w) => text.includes(` ${w} `));
}
