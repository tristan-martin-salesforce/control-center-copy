"use client";
/**
 * Agent behavior (R-UI-16): autonomy per action type (L0–L4), voice, watched sources and drafting style. Each block
 * keeps its own draft and has its own explicit Save (UI-SPEC §8: autonomy changes matter). What counts as a task is
 * set in Role & rules (D-55): the old task list (`agentBehavior.taskCapture`) only points there now, and anything
 * you typed into it is carried over as your own rules the first time you open Role & rules.
 */
import { useState } from "react";
import type { AutonomyLevel } from "@/contract";
import { Button, cn, SegmentedToggle, Skeleton } from "@/ui";
import { actionLabel, AUTONOMY_LEVELS, autonomyRaised } from "./derive";
import { AppLink } from "@/components/shell/AppLink";
import { Glyph, MiniButton, TextInput } from "./controls";
import {
  Block,
  Instant,
  Row,
  SaveActions,
  SaveFeedback,
  Section,
} from "./form";
import { useSettingsModel } from "./state";
import s from "./settings.module.css";

/** Messages that leave (Slack, email) never run without a click: L4 stays off for them. */
const LEAVES = new Set(["slack_reply", "email_reply"]);
const LEVEL_WORD: Record<AutonomyLevel, string> = {
  L0: "Suggest",
  L1: "Draft",
  L2: "Stage",
  L3: "One-click",
  L4: "Auto",
};

function AddLine({
  label,
  placeholder,
  onAdd,
}: {
  label: string;
  placeholder: string;
  onAdd: (v: string) => void;
}) {
  const [v, setV] = useState("");
  const commit = () => {
    if (!v.trim()) return;
    onAdd(v.trim());
    setV("");
  };
  return (
    <div className={s.ctrl}>
      <TextInput
        width="full"
        style={{ flex: 1, width: "auto" }}
        aria-label={label}
        placeholder={placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit())}
      />
      <Button variant="secondary" onClick={commit} disabled={!v.trim()}>
        Add
      </Button>
    </div>
  );
}

function jumpTo(id: string) {
  document
    .getElementById(id)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
}

export function AgentSection() {
  const { voice, autonomy, watched, drafting } = useSettingsModel().agent;
  const [showSamples, setShowSamples] = useState(false);
  const a = (autonomy.draft.autonomy ?? {}) as Record<string, AutonomyLevel>;
  const raised = autonomy.server
    ? autonomyRaised(autonomy.server.autonomy, a)
    : [];
  const v = voice.draft.voice;
  const sources = watched.draft.watchedSources ?? [];
  const savedSources = new Set(watched.saved.watchedSources ?? []);
  const dr = drafting.draft.drafting;
  const loading = !autonomy.server;
  const jumps: Array<[string, string]> = [
    ["b-auto", "Autonomy"],
    ["b-voice", "Voice"],
    ["b-task", "What counts as a task"],
    ["b-watched", "Watched sources"],
    ["b-draft", "Drafting style"],
  ];

  return (
    <Section
      id="agent"
      title="Autonomy"
      meta="How far the agent may go, how it sounds, and what it reads. Sends and writes never go above what you set here, and each one is audited."
      actions={<Instant>Each block saves on its own</Instant>}
      jump={
        <nav className={s.jump} aria-label="Blocks in this section">
          {jumps.map(([id, l]) => (
            <button
              key={id}
              type="button"
              className={s.linkBtn}
              onClick={() => jumpTo(id)}
            >
              {l}
            </button>
          ))}
        </nav>
      }
    >
      {loading ? (
        <Skeleton variant="block" className="mt-6 h-64 w-full" />
      ) : null}
      <div hidden={loading}>
        <Block
          id="b-auto"
          title="Autonomy"
          help="Per kind of action."
          actions={
            <SaveActions
              variant="secondary"
              saveLabel="Save autonomy"
              idle=""
              dirty={autonomy.dirty}
              onSave={() => void autonomy.save()}
              onDiscard={autonomy.discard}
              mutation={autonomy.mutation}
              savedAt={autonomy.savedAt}
              testId="save-agent-autonomy"
            />
          }
          feedback={
            <>
              <SaveFeedback mutation={autonomy.mutation} />
              {raised.length ? (
                <p role="status" className="text-body text-warning-700">
                  Raising {raised.map(actionLabel).join(", ")} lets the agent
                  execute on approval or on its own. You can lower it again at
                  any time.
                </p>
              ) : null}
            </>
          }
        >
          {Object.entries(a).map(([k, level]) => {
            const meta = AUTONOMY_LEVELS.find((l) => l.level === level);
            return (
              <Row
                key={k}
                label={actionLabel(k)}
                labelId={`a-${k}`}
                help={`${level} · ${meta?.hint ?? ""}`}
                edited={
                  !!autonomy.server && autonomy.server.autonomy[k] !== level
                }
              >
                <SegmentedToggle
                  size="md"
                  label={`Autonomy for ${actionLabel(k)}`}
                  value={level}
                  onChange={(nv) => autonomy.set("autonomy", { ...a, [k]: nv })}
                  options={AUTONOMY_LEVELS.map((l) => ({
                    value: l.level,
                    label: LEVEL_WORD[l.level],
                    disabled:
                      l.level === "L4" && LEAVES.has(k) && level !== "L4",
                  }))}
                />
              </Row>
            );
          })}
          {Object.keys(a).length === 0 ? (
            <p className={cn(s.help, "py-3")}>
              No action types yet. They appear as the agent learns new kinds of
              work.
            </p>
          ) : null}
        </Block>

        <Block
          id="b-voice"
          title="Voice"
          help="The profile drafts are written in."
          actions={
            <SaveActions
              variant="secondary"
              saveLabel="Save voice"
              idle=""
              dirty={voice.dirty}
              onSave={() => void voice.save()}
              onDiscard={voice.discard}
              mutation={voice.mutation}
              savedAt={voice.savedAt}
              testId="save-agent-voice"
            />
          }
          feedback={<SaveFeedback mutation={voice.mutation} />}
        >
          {v ? (
            <>
              <Row
                label="Voice summary"
                htmlFor="v-style"
                top
                help="Edit it to steer how drafts sound."
                edited={voice.dirty && voice.saved.voice?.style !== v.style}
              >
                <textarea
                  id="v-style"
                  rows={3}
                  className={s.in}
                  value={v.style}
                  onChange={(e) =>
                    voice.set("voice", { ...v, style: e.target.value })
                  }
                />
              </Row>
              <Row
                label="Samples"
                top
                help="Sent messages the profile was learned from. Remove any that don't sound like you."
                edited={
                  voice.dirty &&
                  voice.saved.voice?.samples.length !== v.samples.length
                }
              >
                <div className={`${s.ctrl} ${s.stack}`}>
                  <div className={s.ctrl}>
                    <span>
                      {v.samples.length} sample
                      {v.samples.length === 1 ? "" : "s"} from your sent Slack
                      and Gmail
                    </span>
                    {v.samples.length ? (
                      <button
                        type="button"
                        className={s.linkBtn}
                        aria-expanded={showSamples}
                        onClick={() => setShowSamples((x) => !x)}
                      >
                        {showSamples ? "Hide samples" : "Review samples →"}
                      </button>
                    ) : null}
                  </div>
                  {showSamples ? (
                    <div className={s.listEdit} aria-label="Voice samples">
                      {v.samples.map((smp, i) => (
                        <div key={i} className={s.sample}>
                          <span title={smp}>{smp}</span>
                          <MiniButton
                            label="Remove sample"
                            onClick={() =>
                              voice.set("voice", {
                                ...v,
                                samples: v.samples.filter((_, j) => j !== i),
                              })
                            }
                          >
                            <Glyph name="close" />
                          </MiniButton>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {!v.samples.length ? (
                    <span className={s.help}>
                      No samples. Drafts fall back to the summary above.
                    </span>
                  ) : null}
                </div>
              </Row>
            </>
          ) : null}
        </Block>

        <Block id="b-task" title="What counts as a task">
          <Row
            label="Task rules"
            help="Your role's rules and your own, with their thresholds."
          >
            <span>
              What counts as a task is set in{" "}
              <AppLink
                className={s.linkBtn}
                href="/settings?section=role"
                replace
                data-testid="agent-task-rules-link"
              >
                Role &amp; rules
              </AppLink>
              .
            </span>
          </Row>
        </Block>

        <Block
          id="b-watched"
          title="Watched sources and channels"
          help="What the scanners read for asks and promises."
          actions={
            <SaveActions
              variant="secondary"
              saveLabel="Save sources"
              idle=""
              dirty={watched.dirty}
              onSave={() => void watched.save()}
              onDiscard={watched.discard}
              mutation={watched.mutation}
              savedAt={watched.savedAt}
              testId="save-agent-watched"
            />
          }
          feedback={<SaveFeedback mutation={watched.mutation} />}
        >
          <Row
            label="Watched"
            top
            help="Adding a source raises scan cost."
            edited={watched.dirty}
          >
            <div className={`${s.ctrl} ${s.stack}`}>
              <div className={s.chips} aria-label="Watched sources">
                {sources.map((src) => (
                  <span
                    key={src}
                    className={cn(s.chip, !savedSources.has(src) && s.chipNew)}
                  >
                    {src}
                    <MiniButton
                      label={`Remove ${src}`}
                      onClick={() =>
                        watched.set(
                          "watchedSources",
                          sources.filter((x) => x !== src),
                        )
                      }
                    >
                      <Glyph name="close" />
                    </MiniButton>
                  </span>
                ))}
                {sources.length === 0 ? (
                  <span className={s.help}>
                    Nothing watched. The scanners only read DMs and mail to you.
                  </span>
                ) : null}
              </div>
              <AddLine
                label="Add a watched source"
                placeholder="#channel, a person, or a source name"
                onAdd={(t) =>
                  !sources.includes(t) &&
                  watched.set("watchedSources", [...sources, t])
                }
              />
            </div>
          </Row>
        </Block>

        <Block
          id="b-draft"
          title="Drafting style"
          actions={
            <SaveActions
              variant="secondary"
              saveLabel="Save style"
              idle=""
              dirty={drafting.dirty}
              onSave={() => void drafting.save()}
              onDiscard={drafting.discard}
              mutation={drafting.mutation}
              savedAt={drafting.savedAt}
              testId="save-agent-drafting"
            />
          }
          feedback={<SaveFeedback mutation={drafting.mutation} />}
        >
          {dr ? (
            <>
              <Row
                label="Tone"
                labelId="l-tone"
                edited={drafting.saved.drafting?.tone !== dr.tone}
              >
                <SegmentedToggle
                  size="md"
                  label="Tone"
                  value={dr.tone}
                  onChange={(t) => drafting.set("drafting", { ...dr, tone: t })}
                  options={[
                    { value: "crisp", label: "Crisp" },
                    { value: "warm", label: "Warm" },
                    { value: "formal", label: "Formal" },
                  ]}
                />
              </Row>
              <Row
                label="Length"
                labelId="l-len"
                edited={drafting.saved.drafting?.length !== dr.length}
              >
                <SegmentedToggle
                  size="md"
                  label="Length"
                  value={dr.length}
                  onChange={(l) =>
                    drafting.set("drafting", { ...dr, length: l })
                  }
                  options={[
                    { value: "short", label: "Short" },
                    { value: "medium", label: "Medium" },
                    { value: "long", label: "Long" },
                  ]}
                />
              </Row>
              <Row
                label="Sign-off"
                htmlFor="d-sign"
                help="Blank means none."
                edited={drafting.saved.drafting?.signoff !== dr.signoff}
              >
                <TextInput
                  id="d-sign"
                  placeholder="None"
                  value={dr.signoff}
                  onChange={(e) =>
                    drafting.set("drafting", { ...dr, signoff: e.target.value })
                  }
                />
              </Row>
            </>
          ) : null}
        </Block>
      </div>
    </Section>
  );
}
