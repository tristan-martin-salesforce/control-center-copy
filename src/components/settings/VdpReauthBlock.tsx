'use client';
/**
 * Settings ▸ Sources ▸ VDP re-auth: where the cookie refresh script lives and which Python runs it. Health's
 * "Re-auth VDP" (the error catalog's label; and the Assistant's reconnect) runs it on this Mac through the worker: silently while the Okta session
 * is live, else in Terminal with a browser for MFA. Saved instantly into `settings.scanning` on blur or Enter; the
 * worker reads it on the next click (src/reauth/run.ts).
 */
import { useEffect, useState } from 'react';
import { DEFAULT_VDP_REFRESH_SCRIPT, VDP_PYTHON_RE, VDP_REFRESH_SCRIPT_RE, vdpRefreshCommand, type ScanningSettings } from '@/contract';
import { useScanningModel } from './ScanningSection';
import { TextInput } from './controls';
import { Block, Row } from './form';

type Patch = Partial<Pick<ScanningSettings, 'vdpRefreshScript' | 'vdpPython'>>;

/** The patch the two fields produce: only valid values that differ from what is saved. */
export function vdpReauthPatch(saved: Pick<ScanningSettings, 'vdpRefreshScript' | 'vdpPython'>, script: string, python: string): Patch {
  const p: Patch = {};
  const sc = script.trim() || DEFAULT_VDP_REFRESH_SCRIPT;
  const py = python.trim();
  if (VDP_REFRESH_SCRIPT_RE.test(sc) && sc !== saved.vdpRefreshScript) p.vdpRefreshScript = sc;
  if (VDP_PYTHON_RE.test(py) && py !== saved.vdpPython) p.vdpPython = py;
  return p;
}

export function VdpReauthBlock() {
  const m = useScanningModel();
  const saved = m.value;
  const [script, setScript] = useState(saved.vdpRefreshScript);
  const [python, setPython] = useState(saved.vdpPython);
  useEffect(() => setScript(saved.vdpRefreshScript), [saved.vdpRefreshScript]);
  useEffect(() => setPython(saved.vdpPython), [saved.vdpPython]);
  const scriptErr = VDP_REFRESH_SCRIPT_RE.test(script.trim() || DEFAULT_VDP_REFRESH_SCRIPT) ? null : 'A .py path that starts with ~/ or /, without quotes';
  const pythonErr = VDP_PYTHON_RE.test(python.trim()) ? null : 'A python path or name, like /usr/bin/python3';
  const save = () => {
    const p = vdpReauthPatch(saved, script, python);
    if (Object.keys(p).length) m.set(p);
  };
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') save();
  };
  return (
    <Block
      id="sources-vdp-reauth"
      title="VDP re-auth"
      help="“Re-auth VDP” in Health runs this script on this Mac: silently while your Okta session is live, else in Terminal with a browser window for MFA."
    >
      <Row label="Refresh script" htmlFor="vdp-script" error={scriptErr} help={`Where refresh_vdp_fir_cookie.py lives (it ships with the vdp-app repo). Default: ${DEFAULT_VDP_REFRESH_SCRIPT}`}>
        <TextInput
          id="vdp-script"
          width="full"
          value={script}
          disabled={!m.ready}
          spellCheck={false}
          aria-invalid={!!scriptErr}
          data-testid="vdp-refresh-script"
          onChange={(e) => setScript(e.target.value)}
          onBlur={save}
          onKeyDown={onEnter}
        />
      </Row>
      <Row label="Python" htmlFor="vdp-python" error={pythonErr} help="It needs Playwright. Leave empty to use the first python3 on this Mac that has it.">
        <TextInput
          id="vdp-python"
          width="md"
          value={python}
          placeholder="Auto (a python3 with Playwright)"
          disabled={!m.ready}
          spellCheck={false}
          aria-invalid={!!pythonErr}
          data-testid="vdp-python"
          onChange={(e) => setPython(e.target.value)}
          onBlur={save}
          onKeyDown={onEnter}
        />
      </Row>
      <p className="text-caption text-muted">
        To run it yourself: <code className="font-mono">{vdpRefreshCommand({ vdpRefreshScript: script.trim() || DEFAULT_VDP_REFRESH_SCRIPT, vdpPython: python.trim() })}</code>
      </p>
    </Block>
  );
}
