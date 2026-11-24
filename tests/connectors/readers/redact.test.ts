import { describe, expect, it } from 'vitest';
import { redact, redactDeep, redactExcerpt } from '@/connectors/redact';

describe('redact', () => {
  const cases: Array<[string, string, string]> = [
    ['slack bot token', 'token is xoxb-1234567890-abcdefghijkl here', 'slack_token'],
    ['slack app token', 'xapp-1-A0123456789-abcdef0123456789', 'slack_token'],
    ['anthropic key', 'key sk-ant-api03-abcdefghijklmnop1234', 'api_key'],
    ['github pat', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github_token'],
    ['aws key', 'AKIAIOSFODNN7EXAMPLE', 'aws_key'],
    ['google token', 'ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz', 'google_token'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'jwt'],
    ['salesforce session id', 'sid 00D5g000001AbCdEFG!AQEAQabcdefghijklmnopqrstuvwxyz0123456789', 'sf_session'],
    ['bearer', 'Authorization header: Bearer abcdefghijklmnop1234567890', 'bearer'],
    ['cookie header', 'Cookie: session=abcdef0123456789; other=1', 'cookie'],
    ['url token', 'https://x.example.com/cb?access_token=abcdef0123456789&x=1', 'url_token'],
    ['password label', 'password: hunter2hunter2', 'password'],
    ['pwd is', 'the pwd is Sup3rSecret', 'password'],
    ['client secret', 'client_secret=abcd1234efgh5678', 'password'],
    ['demo login pair', 'demo login: workshop_user / pw: Sup3rSecret!9', 'login_pair'],
    ['ssn', 'SSN 123-45-6789 on file', 'ssn'],
    ['card (luhn valid)', 'card 4111 1111 1111 1111 exp 12/29', 'card'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'private_key'],
  ];
  it.each(cases)('redacts %s', (_n, input, kind) => {
    const r = redact(input);
    expect(r.redacted).toBe(true);
    expect(r.kinds).toContain(kind);
    expect(r.text).toContain(`[REDACTED:${kind}]`);
  });

  it('never leaves the secret value behind', () => {
    const secrets = ['Sup3rSecret!9', 'hunter2hunter2', 'abcdef0123456789', '4111 1111 1111 1111', 'xoxb-1234567890-abcdefghijkl'];
    const r = redact(secrets.map((s, i) => ['demo login: u / pw: ', 'password: ', 'Cookie: s=', 'card ', 'tok '][i] + s).join('\n'));
    for (const s of secrets) expect(r.text).not.toContain(s);
  });

  it('keeps the label so the agent knows something was there', () => {
    expect(redact('password: hunter2hunter2').text).toBe('password: [REDACTED:password]');
  });

  it('leaves ordinary text and non-Luhn numbers alone', () => {
    const t = 'Workshop on 2026-03-10, order 1234 5678 9012 3456, call (313) 555-0100, ticket 00D is not a session';
    const r = redact(t);
    expect(r.text).toBe(t);
    expect(r.redacted).toBe(false);
  });

  it('is idempotent', () => {
    const once = redact('password: hunter2hunter2 and Bearer abcdefghijklmnop1234567890').text;
    expect(redact(once).text).toBe(once);
  });

  it('redactExcerpt truncates to the excerpt limit after redacting', () => {
    const r = redactExcerpt('password: hunter2hunter2 ' + 'x'.repeat(2000), 1000);
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.redacted).toBe(true);
    expect(r.text).not.toContain('hunter2');
  });

  it('redactDeep walks nested payloads', () => {
    const { value, redacted } = redactDeep({ a: ['token: abcdefgh12345678'], b: { c: 'fine' } });
    expect(redacted).toBe(true);
    expect(JSON.stringify(value)).not.toContain('abcdefgh12345678');
    expect(value.b.c).toBe('fine');
  });
});
