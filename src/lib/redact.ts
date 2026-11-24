/**
 * Credential redaction (tenet: Local data, privacy-safe logs).
 *
 * Applied twice: the skills tell the agent to mask secrets before calling `cc_record_source_items`,
 * and the cc tools run this again on every excerpt/title/payload string (defense in depth).
 * Also used on stderr and error text before anything is logged.
 *
 * Patterns follow brief 09 §5.2 (`xox[abp]-`, `sk-`, `Bearer`, JWTs, `00D…!`, `password:`), plus common
 * cloud keys, private keys and connection strings.
 */

export type RedactionKind =
  | 'slack_token'
  | 'api_key'
  | 'bearer'
  | 'jwt'
  | 'sf_session'
  | 'password'
  | 'aws_key'
  | 'private_key'
  | 'connection_string'
  | 'github_token'
  | 'google_key'
  | 'cookie'
  | 'password_share'
  | 'login'
  | 'generic_secret';

interface Rule {
  kind: RedactionKind;
  re: RegExp;
  /** Replacement; `$1` keeps a leading label such as `password:`. */
  replace: string;
}

const MASK = '[REDACTED]';

const RULES: Rule[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: `[REDACTED:private_key]` },
  // RED-1: a password-manager share link IS the credential (1Password, Bitwarden Send, Keeper, One-Time Secret, …).
  { kind: 'password_share', re: /\bhttps?:\/\/(?:share\.1password\.(?:com|eu|ca)|[a-z0-9-]+\.1password\.(?:com|eu|ca)\/(?:s|share)\b|send\.bitwarden\.com|vault\.bitwarden\.(?:com|eu)\/#\/send|(?:www\.)?keepersecurity\.(?:com|eu)\/vault\/share|(?:[a-z]+\.)?onetimesecret\.com\/(?:secret|private)|pwpush\.com\/(?:[a-z]{2}\/)?p\/|privnote\.com\/|(?:www\.)?lastpass\.com\/(?:share|s)\/|app\.dashlane\.com\/share)[^\s|>"'`)\]]*/gi, replace: `[REDACTED:password_share]` },
  // RED-1: login lines: "user: x / pw: y", "login: x@y.com / Secret1", "username: x" then "p: y" on the next line.
  { kind: 'login', re: /\b((?:user(?:name)?|login|email)\s*[:=]\s*\S+\s*(?:[/,|;]|\band\b)\s*(?:pass(?:word)?|pw|pwd)\s*[:=]\s*)(?!\[REDACTED)\S+/gi, replace: `$1${MASK}` },
  { kind: 'login', re: /\b((?:user(?:name)?|login|creds?|credentials)\s*[:=]\s*\S+\s*[/|]\s*)(?!\[REDACTED)(?!(?:pass(?:word)?|pw|pwd)\s*[:=])[^\s"'`<>,;]{4,}/gi, replace: `$1${MASK}` },
  { kind: 'login', re: /\b((?:user(?:name)?|login|u)\s*[:=]\s*\S+[ \t]*\r?\n[ \t]*(?:p|pw|pwd|pass(?:word)?)\s*[:=]\s*)(?!\[REDACTED)\S+/gi, replace: `$1${MASK}` },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, replace: `[REDACTED:slack_token]` },
  { kind: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: `[REDACTED:github_token]` },
  { kind: 'api_key', re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: `[REDACTED:api_key]` },
  { kind: 'google_key', re: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: `[REDACTED:google_key]` },
  // SEC-1: Google OAuth access tokens, VDP's PAT and its Okta gateway cookie without a `Cookie:` label (a raw log line
  // in the feedback Diagnostics block goes through this before it can be posted)
  { kind: 'google_key', re: /\bya29\.[A-Za-z0-9_-]{20,}/g, replace: `[REDACTED:google_key]` },
  { kind: 'api_key', re: /\bvdp_pat_[A-Za-z0-9_-]{16,}/g, replace: `[REDACTED:api_key]` },
  { kind: 'cookie', re: /\b(central_proxy_session=)[^;\s"'&]{8,}/g, replace: `$1${MASK}` },
  { kind: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: `[REDACTED:aws_key]` },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: `[REDACTED:jwt]` },
  { kind: 'bearer', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: `$1 ${MASK}` },
  // Salesforce session ids: 00D<15 or 18-char org id>!<token>
  { kind: 'sf_session', re: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}/g, replace: `[REDACTED:sf_session]` },
  {
    kind: 'connection_string',
    re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^:\s/@]+:)[^@\s]+@/gi,
    replace: `$1${MASK}@`,
  },
  {
    kind: 'cookie',
    re: /\b((?:set-)?cookie\s*[:=]\s*)[^\n]{8,}/gi,
    replace: `$1${MASK}`,
  },
  {
    kind: 'password',
    // "password: hunter2", "pwd=…", "passcode - …", "pw: …"; keeps the label, masks the value token.
    re: /\b((?:pass(?:word|wd|code|phrase)|pwd|pw)(?:\s*[:=]\s*|\s+is\s*[:=]?\s*|\s+-\s+))("[^"]+"|'[^']+'|`[^`]+`|\S+)/gi,
    replace: `$1${MASK}`,
  },
  {
    kind: 'generic_secret',
    re: /\b((?:api[_-]?key|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token)\s*[:=]\s*)("[^"]+"|'[^']+'|[A-Za-z0-9._~+/=-]{12,})/gi,
    replace: `$1${MASK}`,
  },
];

export interface RedactionResult {
  text: string;
  redacted: boolean;
  count: number;
  kinds: RedactionKind[];
}

/** Mask credential-like substrings. Idempotent: redacting twice gives the same text. */
export function redact(input: string): RedactionResult {
  let text = input;
  let count = 0;
  const kinds = new Set<RedactionKind>();
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args: unknown[]) => {
      const match = String(args[0]);
      if (match.includes('[REDACTED')) return match;
      count += 1;
      kinds.add(rule.kind);
      // Re-run the single rule on the match to honour $1 back-references.
      return match.replace(new RegExp(rule.re.source, rule.re.flags.replace('g', '')), rule.replace);
    });
  }
  return { text, redacted: count > 0, count, kinds: [...kinds] };
}

export const redactText = (s: string): string => redact(s).text;

/** Keys whose values are never kept in payloads, whatever they contain. */
const SECRET_KEY_RE = /^(?:authorization|cookie|set-cookie|token|access_token|refresh_token|id_token|password|passwd|secret|client_secret|api_key|apikey|x-api-key|session|sessionid|bearer)$/i;

/**
 * Deep-redact a JSON-ish payload: drops secret-named keys, redacts every string, caps depth and size.
 * Returns a new object; the input is not mutated.
 */
export function redactPayload(value: unknown, opts: { maxDepth?: number; maxString?: number; maxArray?: number } = {}): { value: unknown; redacted: boolean } {
  const maxDepth = opts.maxDepth ?? 6;
  const maxString = opts.maxString ?? 4000;
  const maxArray = opts.maxArray ?? 200;
  let redacted = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (v == null) return v;
    if (typeof v === 'string') {
      const r = redact(v.length > maxString ? v.slice(0, maxString) : v);
      if (r.redacted) redacted = true;
      return r.text;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (depth >= maxDepth) return '[TRUNCATED]';
    if (Array.isArray(v)) return (v.length > maxArray ? v.slice(0, maxArray) : v).map((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k)) {
          redacted = true;
          continue;
        }
        out[k] = walk(val, depth + 1);
      }
      return out;
    }
    return undefined;
  };
  return { value: walk(value, 0), redacted };
}

/** For logs: redact and cap length. Never log bodies; this is for error text and stderr only. */
export function safeLogText(s: string, max = 500): string {
  const t = redactText(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
