import { describe, expect, it } from 'vitest';
import {
  assertReadTool,
  classifyGoogleError,
  DisallowedToolError,
  GOOGLE_READ_TOOLS,
  GoogleCallError,
  GoogleWorkspaceClient,
  googleReauthAction,
  probeFromDiagnosis,
  diagnoseDevbar,
} from '@/connectors/google/client';
import { NOW } from './helpers';

const WRITE_TOOLS = [
  'send_gmail_message',
  'draft_gmail_message',
  'create_event',
  'manage_event',
  'delete_event',
  'modify_gmail_message_labels',
  'batch_modify_gmail_message_labels',
  'manage_gmail_label',
  'set_drive_file_permissions',
  'manage_drive_access',
  'create_drive_file',
  'update_drive_file',
  'copy_drive_file',
  'batch_update_presentation',
  'modify_sheet_values',
  'manage_task',
  'manage_document_comment',
  'create_doc',
  'modify_doc_text',
  'import_to_google_doc',
];

describe('google client allowlist', () => {
  it.each(WRITE_TOOLS)('refuses %s before anything is sent', (t) => {
    expect(() => assertReadTool(t)).toThrow(DisallowedToolError);
  });

  it('allows every listed read tool', () => {
    for (const t of GOOGLE_READ_TOOLS) expect(() => assertReadTool(t)).not.toThrow();
    expect(GOOGLE_READ_TOOLS.size).toBeGreaterThan(20);
  });

  it('call() throws on a write tool without touching the transport', async () => {
    let touched = false;
    const c = new GoogleWorkspaceClient({
      clientFactory: () => ({
        client: {
          connect: async () => {
            touched = true;
          },
          callTool: async () => {
            touched = true;
            return { content: [] };
          },
          close: async () => undefined,
          listTools: async () => ({ tools: [] }),
        } as never,
      }),
    });
    await expect(c.call('send_gmail_message', { to: 'x' })).rejects.toBeInstanceOf(DisallowedToolError);
    expect(touched).toBe(false);
  });
});

describe('google client calls', () => {
  const mk = (script: Array<() => unknown>) => {
    let connects = 0;
    let calls = 0;
    const c = new GoogleWorkspaceClient({
      maxRetries: 2,
      clientFactory: () => ({
        client: {
          connect: async () => {
            connects++;
          },
          callTool: async () => {
            const step = script[Math.min(calls++, script.length - 1)]!;
            return step() as never;
          },
          close: async () => undefined,
          listTools: async () => ({ tools: [{ name: 'get_events' }, { name: 'send_gmail_message' }] }),
        } as never,
      }),
    });
    return { c, stats: () => ({ connects, calls }) };
  };
  const ok = (text: string) => () => ({ content: [{ type: 'text', text }] });

  it('connects lazily and returns text', async () => {
    const { c, stats } = mk([ok('hello')]);
    expect(stats().connects).toBe(0);
    expect(await c.call('get_events', {})).toBe('hello');
    expect(stats().connects).toBe(1);
    await c.call('get_events', {});
    expect(stats().connects).toBe(1);
  });

  it('retries transient failures and reconnects', async () => {
    const { c, stats } = mk([
      () => {
        throw new Error('fetch failed');
      },
      ok('recovered'),
    ]);
    expect(await c.call('get_events', {})).toBe('recovered');
    expect(stats().connects).toBe(2);
  });

  it('does not retry auth errors and classifies them', async () => {
    const { c, stats } = mk([() => ({ isError: true, content: [{ type: 'text', text: 'invalid_grant: Token has been expired or revoked' }] })]);
    const err = await c.call('get_events', {}).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleCallError);
    expect(err.info.errorClass).toBe('auth');
    expect(stats().calls).toBe(1);
  });

  it('reports unknown server tools (not on the allowlist)', async () => {
    const { c } = mk([ok('x')]);
    expect(await c.unknownServerTools()).toEqual(['send_gmail_message']);
  });

  it('times out slow calls', async () => {
    const c = new GoogleWorkspaceClient({
      timeoutMs: 20,
      maxRetries: 0,
      clientFactory: () => ({
        client: { connect: async () => undefined, callTool: () => new Promise(() => undefined), close: async () => undefined, listTools: async () => ({ tools: [] }) } as never,
      }),
    });
    const err = await c.call('get_events', {}).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleCallError);
    expect(err.info.errorClass).toBe('transient');
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const { c } = mk([ok('x')]);
    await expect(c.call('get_events', {}, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('error classification and re-auth', () => {
  it.each([
    ['invalid_grant', 'auth'],
    ['User tristan does not have a valid token for google-workspace-readonly', 'auth'],
    ['HTTP 401 Unauthorized', 'auth'],
    ['connect ECONNREFUSED 127.0.0.1:13316', 'transient'],
    ['ECONNRESET', 'transient'],
    ['rateLimitExceeded', 'rate_limited'],
    ['429 Too Many Requests', 'rate_limited'],
    ['backendError 503', 'transient'],
    ['File not found: 1abc', 'unknown'],
  ])('%s -> %s', (text, cls) => {
    expect(classifyGoogleError(new Error(text)).errorClass).toBe(cls);
  });

  it('marks not-found and no-access as object-scoped, not connector failures', () => {
    expect(classifyGoogleError('404 File not found').objectScoped).toBe(true);
    expect(classifyGoogleError('403 forbidden: no access').objectScoped).toBe(true);
  });

  it('DRV-2: a 400 on one file read is object-scoped (an uploaded .xlsx through the Sheets API)', () => {
    const text = "Error calling tool 'get_spreadsheet_info': API error in get_spreadsheet_info: <HttpError 400 when requesting https://sheets.googleapis.com/v4/spreadsheets/1PlaceholderSheet?fields=spreadsheetId returned \"This operation is not supported for this document\">";
    expect(classifyGoogleError(new Error(text))).toMatchObject({ errorClass: 'unknown', objectScoped: true, signature: 'bad_request' });
    expect(classifyGoogleError('HTTP 401 Unauthorized').objectScoped).toBeUndefined(); // auth stays a connector failure
  });

  it('flags daemon-down', () => {
    expect(classifyGoogleError('connect ECONNREFUSED 127.0.0.1:13316').daemonDown).toBe(true);
  });

  it('Google re-auth is fully in-app and names the exact commands', () => {
    expect(googleReauthAction('connector_disconnected')).toMatchObject({ kind: 'in_app', command: 'devbar mcpgw connectors connect google-workspace-readonly' });
    expect(googleReauthAction('devbar_signed_out')).toMatchObject({ kind: 'in_app', command: 'devbar auth login' });
    expect(googleReauthAction('daemon_down')).toMatchObject({ kind: 'in_app', command: 'devbar daemon start' });
  });

  it('turns a devbar diagnosis into the right health probe', () => {
    expect(probeFromDiagnosis({ daemonUp: false, devbarAuthenticated: null, connectorState: null }, NOW)).toMatchObject({ state: 'down', reauth: { command: 'devbar daemon start' } });
    expect(probeFromDiagnosis({ daemonUp: true, devbarAuthenticated: false, connectorState: null }, NOW)).toMatchObject({ state: 'auth_required', errorClass: 'auth', reauth: { command: 'devbar auth login' } });
    expect(probeFromDiagnosis({ daemonUp: true, devbarAuthenticated: true, connectorState: 'disconnected' }, NOW)).toMatchObject({ state: 'auth_required', reauth: { kind: 'in_app' } });
    expect(probeFromDiagnosis({ daemonUp: true, devbarAuthenticated: true, connectorState: 'connected' }, NOW).state).toBe('degraded');
  });

  it('diagnoseDevbar reads status JSON only (no tokens)', async () => {
    const seen: string[][] = [];
    const d = await diagnoseDevbar(async (args) => {
      seen.push(args);
      if (args[0] === 'mcpgw' && args[1] === 'status') return { listener_ok: true, status: 'running' };
      if (args[0] === 'auth') return { authenticated: true, expiresAt: '2027-02-02T00:00:00Z' };
      return { providers: [{ name: 'Google Workspace Read Only', state: 'connected', statusMessage: 'User someone has a valid token for google-workspace-readonly (expires in 58m0s)' }] };
    });
    expect(d).toMatchObject({ daemonUp: true, devbarAuthenticated: true, connectorState: 'connected' });
    // Never the `devbar auth claude` command, which prints a key.
    expect(seen.flat()).not.toContain('claude');
  });

  it('health() reports auth_required with the in-app reauth action when Google rejects the token', async () => {
    const c = new GoogleWorkspaceClient({
      maxRetries: 0,
      clock: () => NOW,
      exec: async (args) => {
        if (args[0] === 'mcpgw' && args[1] === 'status') return { listener_ok: true, status: 'running' };
        if (args[0] === 'auth') return { authenticated: true };
        return { providers: [{ name: 'Google Workspace Read Only', state: 'disconnected' }] };
      },
      clientFactory: () => ({
        client: {
          connect: async () => undefined,
          callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'invalid_grant' }] }),
          close: async () => undefined,
          listTools: async () => ({ tools: [] }),
        } as never,
      }),
    });
    const h = await c.health();
    expect(h.state).toBe('auth_required');
    expect(h.errorClass).toBe('auth');
    expect(h.reauth?.kind).toBe('in_app');
    expect(h.reauth?.command).toContain('connectors connect');
  });
});
