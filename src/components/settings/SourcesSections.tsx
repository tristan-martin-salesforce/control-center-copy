"use client";
/**
 * Sources: Connectors (read-only access, health, Scan now and Re-auth; no config to save) and Watches
 * (explicit Save: a watch changes scanning scope and cost).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Connector, WatchSubscription } from "@/contract";
import { api, type ApiError } from "@/client/api";
import { useApi } from "@/client/hooks";
import { PersonaGate } from "@/client/persona";
import { toast } from "@/client/toast";
import { Button, cn, Skeleton, useNow, useTimeZone } from "@/ui";
import { fmtClock, fmtDay } from "@/ui/format";
import { normaliseWatchTarget } from "./derive";
import { Check, Glyph, MiniButton, Select, TextInput } from "./controls";
import { Block, Instant, SaveActions, Section } from "./form";
import { useSettingsModel } from "./state";
import s from "./settings.module.css";
import { VdpReauthBlock } from "./VdpReauthBlock";
import { reauthErrorToast } from "@/components/health/derive";

// ── Connectors ─────────────────────────────────────────────────────────────────────────────

export const BROKEN = new Set(["auth_needed", "error", "offline"]);
const RANK: Record<string, number> = {
  auth_needed: 0,
  error: 0,
  offline: 0,
  degraded: 1,
  catching_up: 2,
};

export function sortConnectors(cs: Connector[]): Connector[] {
  return [...cs].sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3));
}

export function useConnectorActions() {
  const qc = useQueryClient();
  const refresh = () => {
    for (const t of ["health", "scans", "jobs", "event_log"])
      void qc.invalidateQueries({ queryKey: [t] });
  };
  const scan = useMutation({
    mutationFn: (c: Connector) =>
      api("scanConnector", { params: { id: c.id }, body: {} }),
    onSuccess: (res, c) =>
      toast({
        key: `scan-${c.id}`,
        tone: res.entity.status === "auth_failed" ? "warning" : "success",
        title:
          res.entity.status === "auth_failed"
            ? `${c.label} needs re-auth first`
            : `Scanning ${c.label}`,
        body:
          res.entity.status === "auth_failed"
            ? "The scan was recorded as failed."
            : "Results appear in the scan ledger on Health.",
      }),
    onError: (e: ApiError, c) =>
      toast({
        key: `scan-${c.id}`,
        tone: "error",
        title: `Couldn't scan ${c.label}`,
        body: e.message,
      }),
    onSettled: refresh,
  });
  const reauth = useMutation({
    mutationFn: (c: Connector) =>
      api("reauthConnector", { params: { id: c.id }, body: {} }),
    onSuccess: (res, c) => {
      const kind = res.action?.kind ?? c.reauth?.kind ?? "instructions";
      toast({
        key: `reauth-${c.id}`,
        tone: "info",
        title:
          kind === "in_app"
            ? `Re-authenticating ${c.label}`
            : `Re-auth ${c.label} in Terminal`,
        body:
          kind === "in_app"
            ? "This takes a moment."
            : "Run the command shown, then come back.",
      });
    },
    onError: (e: ApiError, c) => toast(reauthErrorToast(c, e.message)),
    onSettled: refresh,
  });
  return { scan, reauth };
}

export function ConnectorStatus({ c }: { c: Connector }) {
  if (BROKEN.has(c.state))
    return (
      <span className={cn(s.badge, s.badgeDanger)}>
        <Glyph name="warn" className={s.attnIcon} />
        {c.state === "auth_needed"
          ? "Needs re-auth"
          : c.state === "offline"
            ? "Offline"
            : "Error"}
      </span>
    );
  if (c.state === "degraded")
    return <span className="font-bold text-warning-700">▲ Degraded</span>;
  if (c.state === "catching_up")
    return <span className={s.muted}>Catching up {c.catchUpPct ?? 0}%</span>;
  if (c.state === "paused") return <span className={s.muted}>Paused</span>;
  return <span className={s.muted}>✓ Live</span>;
}

export function dataThrough(c: Connector, now: Date, tz?: string): string {
  const at = c.cursor.at ?? c.lastSuccessAt;
  if (!at) return "—";
  return fmtDay(at, tz) === fmtDay(now, tz) ? fmtClock(at, tz) : fmtDay(at, tz);
}

export function ConnectorsSection({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const health = useApi("getHealth");
  const now = useNow();
  const tz = useTimeZone();
  const a = useConnectorActions();
  const cs = sortConnectors(health.data?.connectors ?? []);
  const current =
    selected && cs.some((c) => c.id === selected) ? selected : cs[0]?.id;
  const live = cs.filter((c) => !BROKEN.has(c.state)).length;
  const newest = cs
    .map((c) => c.cursor.at)
    .filter(Boolean)
    .sort()
    .pop();
  return (
    <Section
      id="connectors"
      title="Connectors"
      actions={<Instant>Nothing to save here</Instant>}
      meta={
        health.data ? (
          <>
            Read-only access to your sources: connectors call read tools only,
            through an allowlist.{" "}
            <b>
              {live} of {cs.length} live
            </b>
            {newest ? `, data through ${fmtClock(newest, tz)}` : ""}.
          </>
        ) : (
          "Read-only access to your sources: connectors call read tools only, through an allowlist."
        )
      }
    >
      <Block>
        {health.isLoading ? (
          <Skeleton variant="row" count={8} />
        ) : health.error ? (
          <p role="alert" className="py-3 text-body text-danger-700">
            Couldn’t load connector health: {health.error.message}.{" "}
            <button
              type="button"
              className={s.linkBtn}
              onClick={() => void health.refetch()}
            >
              Retry
            </button>
          </p>
        ) : (
          <div className={s.tblWrap} data-guide="connectors">
            <table className={s.tbl} aria-label="Connectors">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Data through</th>
                  <th className={s.r}>Items today</th>
                  <th className={s.hideNarrow}>Access</th>
                  <th className={s.r}>
                    <span className={s.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {cs.map((c) => (
                  <tr
                    key={c.id}
                    className={cn(c.id === current && s.changed)}
                    data-connector={c.id}
                    aria-selected={c.id === current}
                    onClick={() => onSelect(c.id)}
                  >
                    <td className="whitespace-nowrap font-bold text-fg-heading">
                      {c.label}
                    </td>
                    <td>
                      <ConnectorStatus c={c} />
                    </td>
                    <td className={s.tnum}>{dataThrough(c, now, tz)}</td>
                    <td className={cn(s.r, s.tnum)}>{c.itemsToday}</td>
                    <td
                      className={cn(s.muted, s.hideNarrow, "whitespace-nowrap")}
                    >
                      Read tools only
                    </td>
                    <td className={s.r}>
                      {BROKEN.has(c.state) ? (
                        <Button
                          variant="ghost"
                          onClick={(e) => (e.stopPropagation(), onSelect(c.id))}
                          aria-label={`Details for ${c.label}`}
                        >
                          Details
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          loading={
                            a.scan.isPending && a.scan.variables?.id === c.id
                          }
                          onClick={(e) => (
                            e.stopPropagation(),
                            a.scan.mutate(c)
                          )}
                          aria-label={`Scan now: ${c.label}`}
                        >
                          Scan now
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>
      {/* D-55: the VDP source has no daily surface while it is not active (an AE's preset) */}
      <PersonaGate gate={{ connector: "vdp" }}>
        <VdpReauthBlock />
      </PersonaGate>
    </Section>
  );
}

// ── Watches ────────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<WatchSubscription["targetKind"], string> = {
  channel: "Slack channel",
  opp: "Opportunity",
  account: "Account",
  person: "Person",
  search: "Search",
};
const CADENCES: Array<[WatchSubscription["cadence"], string]> = [
  ["daily_0730", "Daily 07:30"],
  ["every_4h", "Every 4 h"],
  ["since_last_open", "Since last open"],
];
export const cadenceText = (c: WatchSubscription["cadence"]) =>
  CADENCES.find(([v]) => v === c)?.[1] ?? c;

export function WatchesSection() {
  const w = useSettingsModel().watches;
  const [text, setText] = useState("");
  const typed = normaliseWatchTarget(text);
  const dup =
    typed &&
    (w.rows.some((r) => r.target === typed.target) ||
      w.adds.some((r) => r.target === typed.target));
  const add = () => {
    if (!typed || dup) return;
    w.add({ ...typed, cadence: "daily_0730", style: "brief" });
    setText("");
  };
  return (
    <Section
      id="watches"
      title="Watches"
      meta="Channels summarized into a brief on a schedule. Changing a watch changes scanning scope and cost."
      actions={
        <SaveActions
          dirty={w.dirty}
          onSave={() => void w.save()}
          onDiscard={w.discard}
          pending={w.saving}
          savedAt={w.savedAt}
          testId="save-watches"
        />
      }
      feedback={
        w.error ? (
          <p role="alert" className="text-body text-danger-700">
            Couldn’t save: {w.error.message} Your changes are kept.{" "}
            <button
              type="button"
              className={s.linkBtn}
              onClick={w.error.conflict ? w.reload : () => void w.save()}
            >
              {w.error.conflict ? "Reload" : "Retry"}
            </button>
          </p>
        ) : null
      }
    >
      <Block>
        {w.query.isLoading ? (
          <Skeleton variant="row" count={3} />
        ) : w.query.error ? (
          <p role="alert" className="py-3 text-body text-danger-700">
            Couldn’t load watches: {w.query.error.message}.{" "}
            <button type="button" className={s.linkBtn} onClick={w.reload}>
              Retry
            </button>
          </p>
        ) : (
          <table className={s.tbl} aria-label="Watches">
            <thead>
              <tr>
                <th style={{ width: 48 }}>On</th>
                <th>Watch</th>
                <th>Kind</th>
                <th>Cadence</th>
                <th>Style</th>
                <th style={{ width: 44 }}>
                  <span className={s.srOnly}>Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {w.rows.length === 0 && w.adds.length === 0 ? (
                <tr>
                  <td colSpan={6} className={s.muted}>
                    No watches yet. Add a channel or a person below to get a
                    brief on it.
                  </td>
                </tr>
              ) : null}
              {w.rows.map((r) => (
                <tr
                  key={r.id}
                  className={cn(
                    !r.enabled && s.off,
                    w.edits[r.id] && s.changed,
                  )}
                  data-watch={r.id}
                >
                  <td>
                    <Check
                      checked={r.enabled}
                      onChange={(v) => w.edit(r.id, { enabled: v })}
                      label={`${r.label} on`}
                    />
                  </td>
                  <td
                    className={cn(
                      "font-bold",
                      r.enabled ? "text-fg-heading" : "text-muted",
                    )}
                  >
                    {r.label}
                  </td>
                  <td className={s.muted}>{KIND_LABEL[r.targetKind]}</td>
                  <td>
                    <Select
                      aria-label={`Cadence for ${r.label}`}
                      value={r.cadence}
                      onChange={(e) =>
                        w.edit(r.id, {
                          cadence: e.target
                            .value as WatchSubscription["cadence"],
                        })
                      }
                    >
                      {CADENCES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Select
                      aria-label={`Style for ${r.label}`}
                      value={r.style}
                      onChange={(e) =>
                        w.edit(r.id, {
                          style: e.target.value as WatchSubscription["style"],
                        })
                      }
                    >
                      <option value="brief">Brief</option>
                      <option value="detailed">Detailed</option>
                    </Select>
                  </td>
                  <td />
                </tr>
              ))}
              {w.adds.map((r) => (
                <tr
                  key={r.tmpId}
                  className={s.changed}
                  data-watch-new={r.target}
                >
                  <td>
                    <span className={s.badge}>New</span>
                  </td>
                  <td className="font-bold text-fg-heading">{r.label}</td>
                  <td className={s.muted}>{KIND_LABEL[r.targetKind]}</td>
                  <td className={s.muted}>{cadenceText(r.cadence)}</td>
                  <td className={s.muted}>
                    {r.style === "brief" ? "Brief" : "Detailed"}
                  </td>
                  <td>
                    <MiniButton
                      label={`Remove ${r.label}`}
                      onClick={() => w.removeAdd(r.tmpId)}
                    >
                      <Glyph name="close" />
                    </MiniButton>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}>
                  <form
                    className={s.addRow}
                    onSubmit={(e) => {
                      e.preventDefault();
                      add();
                    }}
                  >
                    <TextInput
                      width="full"
                      style={{ flex: "1 1 280px", width: "auto" }}
                      aria-label="New watch"
                      placeholder="Add a channel or person, e.g. #team-channel or @name"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={!typed || !!dup}
                    >
                      Add watch
                    </Button>
                    {dup ? (
                      <span className={s.help}>Already watched.</span>
                    ) : null}
                  </form>
                </td>
              </tr>
            </tfoot>
          </table>
        )}
        <p className={s.help} style={{ marginTop: 12 }}>
          Pausing a watch keeps its history; nothing is deleted. Changes apply
          when you press Save.
        </p>
      </Block>
    </Section>
  );
}
