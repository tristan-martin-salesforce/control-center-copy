/**
 * devbar's MCP gateway down for maintenance (2026-11-13): every Google read got its HTML maintenance page (HTTP 503)
 * on most calls for an hour. The first 300 characters of the error were markup, so the cause never showed, nothing
 * classified it, and Health said "Inbox: a run failed". Now the page is read as its text, classified as the gateway's
 * outage (transient: retried, no re-auth offered), and Health says so in plain words.
 */
import { describe, expect, it, vi } from 'vitest';

import { classifyGoogleError, GATEWAY_DOWN_WORDS, GATEWAY_ERROR_WORDS, GoogleCallError, GoogleWorkspaceClient, htmlPageText } from '@/connectors/google/client';
import { classifyError } from '@/llm/errors';
import { statusReason } from '@/scanner/runtime/status-reason';

/** The maintenance page's shape, as the gateway sent it (the SDK prefixes it when a POST fails). */
const PAGE = `<html>
<body>
<center>
    <table bgcolor="white" cellpadding="0" cellspacing="0" width="758">
        <tbody>
        <tr>
            <td><span style="font-family: Verdana; font-size: medium; font-weight: bold;">This application is down for maintenance</span></td>
        </tr>
        <tr>
            <td><span style="font-family: Verdana; font-size: small;">Sorry for the inconvenience. We'll be back shortly.</span></td>
        </tr>
        </tbody>
    </table>
</center>
</body>
</html>`;
const SDK_ERROR = `Streamable HTTP error: Error POSTing to endpoint: ${PAGE}`;

describe('the gateway maintenance page', () => {
  it('reads as its text, so the cause fits the detail', () => {
    expect(htmlPageText(SDK_ERROR)).toBe("Streamable HTTP error: Error POSTing to endpoint: This application is down for maintenance Sorry for the inconvenience. We'll be back shortly.");
    expect(htmlPageText('fetch failed')).toBe('fetch failed');
    const e = new GoogleCallError('search_gmail_messages', classifyGoogleError(new Error(SDK_ERROR)), SDK_ERROR);
    expect(e.message).toBe("google search_gmail_messages failed [gateway_down]: Streamable HTTP error: Error POSTing to endpoint: This application is down for maintenance Sorry for the inconvenience. We'll be back shortly.");
  });

  it('is the gateway’s outage: transient (retried), never auth', () => {
    expect(classifyGoogleError(new Error(SDK_ERROR))).toEqual({ errorClass: 'transient', signature: 'gateway_down' });
    // the runtime classifies the run from the wrapped message
    const msg = new GoogleCallError('get_events', classifyGoogleError(new Error(SDK_ERROR)), SDK_ERROR).message;
    expect(classifyError(new Error(msg))).toMatchObject({ errorClass: 'transient', code: 'maintenance' });
    // an SSO page is still auth (the VDP cookie), a plain 503 still transient
    expect(classifyError(new Error('Unexpected content type: text/html; charset=UTF-8'))).toMatchObject({ errorClass: 'auth', code: 'sso_redirect' });
    expect(classifyGoogleError(new Error('HTTP 503 Service Unavailable'))).toMatchObject({ errorClass: 'transient', signature: 'transient' });
  });

  it('Health says the gateway is down, not "a run failed"', () => {
    const msg = new GoogleCallError('search_gmail_messages', classifyGoogleError(new Error(SDK_ERROR)), SDK_ERROR).message;
    expect(statusReason('gmail', 'inbox', msg, 'transient')).toBe(`Inbox: ${GATEWAY_DOWN_WORDS}`);
    expect(statusReason('drive', 'tracked', msg, 'transient')).toBe(`Drive files: ${GATEWAY_DOWN_WORDS}`);
    // a run stored before the maintenance fix (its message cut inside the markup, classified unknown) is still a
    // failed POST to the gateway: its outage (lane E, E5), not "a run failed"
    expect(statusReason('gmail', 'inbox', `google search_gmail_messages failed [unknown]: ${SDK_ERROR.slice(0, 200)}`, 'unknown')).toBe(`Inbox: ${GATEWAY_ERROR_WORDS}`);
    expect(statusReason('slack', 'inbox', 'Error: This application is down for maintenance', 'transient')).toBe('Slack inbox: the service is down for maintenance (not your sign-in), retrying');
  });

  it('the client retries it, and its health check says so without offering a re-auth', async () => {
    let calls = 0;
    const c = new GoogleWorkspaceClient({
      maxRetries: 1,
      clientFactory: () => ({
        client: {
          connect: async () => undefined,
          callTool: async () => {
            calls++;
            throw new Error(SDK_ERROR);
          },
          close: async () => undefined,
          listTools: async () => ({ tools: [] }),
        } as never,
      }),
      exec: async () => {
        throw new Error('devbar is not called for a gateway outage');
      },
    });
    // the retry's backoff (1 s) runs on a fake clock the test steps, never a real wait
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const drive = async <T>(p: Promise<T>): Promise<T> => {
      let done = false;
      void p.finally(() => (done = true)).catch(() => {});
      for (let i = 0; i < 1_000 && !done; i++) await vi.advanceTimersByTimeAsync(100);
      return p;
    };
    let err: GoogleCallError;
    let h: Awaited<ReturnType<typeof c.health>>;
    try {
      err = (await drive(c.call('get_events', {}).catch((e) => e))) as GoogleCallError;
      expect(calls).toBe(2);
      h = await drive(c.health());
    } finally {
      vi.useRealTimers();
    }
    expect(err.info).toEqual({ errorClass: 'transient', signature: 'gateway_down' });
    expect(h).toMatchObject({ state: 'degraded', errorClass: 'transient', detail: GATEWAY_DOWN_WORDS });
    expect(h.reauth).toBeUndefined();
  });
});

describe('"Streamable HTTP error" is the gateway\'s outage (lane E, E5)', () => {
  const UPSTREAM = 'Streamable HTTP error: Error POSTing to endpoint: upstream request failed';
  const BARE_PAGE = 'Streamable HTTP error: Error POSTing to endpoint: <html><body><center><table><tr><td>Bad gateway</td></tr></table></center></body></html>';

  it('classifies as transient (retried), never unknown', () => {
    for (const m of [UPSTREAM, BARE_PAGE]) {
      expect(classifyGoogleError(new Error(m))).toEqual({ errorClass: 'transient', signature: 'gateway_error' });
      const wrapped = new GoogleCallError('get_events', classifyGoogleError(new Error(m)), m).message;
      expect(wrapped).toMatch(/\[gateway_error\]/);
      expect(classifyError(new Error(wrapped))).toMatchObject({ errorClass: 'transient', code: 'gateway_error' });
      expect(classifyError(new Error(m))).toMatchObject({ errorClass: 'transient', code: 'gateway_error' }); // as the Slack / Org62 relays report it
    }
  });

  it('a refused sign-in through the same transport is still auth', () => {
    expect(classifyError(new Error('Streamable HTTP error: Unexpected content type: text/html'))).toMatchObject({ errorClass: 'auth', code: 'sso_redirect' });
    expect(classifyError(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_auth"}'))).toMatchObject({ errorClass: 'auth' });
    expect(classifyGoogleError(new Error('Streamable HTTP error: Error POSTing to endpoint: not authenticated'))).toMatchObject({ errorClass: 'auth', signature: 'auth' });
    // the maintenance page keeps its own words
    expect(classifyGoogleError(new Error(SDK_ERROR)).signature).toBe('gateway_down');
  });

  it('Health names the gateway, and its health check offers no re-auth', async () => {
    const msg = new GoogleCallError('search_drive_files', classifyGoogleError(new Error(UPSTREAM)), UPSTREAM).message;
    expect(statusReason('drive', 'tracked', msg, 'transient')).toBe(`Drive files: ${GATEWAY_ERROR_WORDS}`);
    expect(statusReason('slack', 'inbox', UPSTREAM, 'transient')).toBe("Slack inbox: the service's gateway isn't answering (not your sign-in), retrying");
    const c = new GoogleWorkspaceClient({
      maxRetries: 0,
      clientFactory: () => ({
        client: {
          connect: async () => undefined,
          callTool: async () => {
            throw new Error(UPSTREAM);
          },
          close: async () => undefined,
          listTools: async () => ({ tools: [] }),
        } as never,
      }),
      exec: async () => {
        throw new Error('devbar is not called for a gateway outage');
      },
    });
    const h = await c.health();
    expect(h).toMatchObject({ state: 'degraded', errorClass: 'transient', detail: GATEWAY_ERROR_WORDS });
    expect(h.reauth).toBeUndefined();
  });
});
