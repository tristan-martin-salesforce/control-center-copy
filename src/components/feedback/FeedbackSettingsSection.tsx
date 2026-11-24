'use client';
/**
 * Settings ▸ Feedback (D-56): where "Report a bug / idea" posts. Explicit save, like the other sections.
 *
 *   Channel id     C… / G… (empty: the team default in config/team.json)
 *   Channel name   "#command-center-feedback" (shown in the panel)
 *   Post live      on: Send posts (still behind Settings ▸ Sending dry run); off: Send shows the payload and copies it
 */
import { useApi } from '@/client/hooks';
import { Switch, TextInput } from '@/components/settings/controls';
import { Block, Row, SaveActions, SaveFeedback, Section, useSectionForm } from '@/components/settings/form';
import { Skeleton } from '@/ui';

const KEYS = ['channelId', 'channelName', 'postLive'] as const;
const CHANNEL_ID = /^(|[CG][A-Z0-9]{6,})$/;

export function useFeedbackForm() {
  return useSectionForm('feedback', KEYS, 'Feedback', 'feedback');
}

export function FeedbackSection() {
  const f = useFeedbackForm();
  const state = useApi('getFeedback');
  const d = f.draft;
  const id = (d.channelId ?? '').trim();
  const idErr = CHANNEL_ID.test(id) ? null : 'A Slack channel id starts with C or G, then letters and digits (from the channel’s About tab).';
  const team = state.data?.channel.source === 'team' ? state.data.channel : null;
  const live = state.data?.channel.live;
  return (
    <Section
      id="feedback"
      title="Feedback"
      meta="Where “Report a bug / idea” posts. Each report is diagnosed, names and ids are swapped for placeholders, and you edit the final text before Send. The app posts only to this channel, only on your Send."
      actions={<SaveActions dirty={f.dirty} onSave={() => void f.save()} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} saveDisabled={!!idErr} testId="save-feedback" />}
      feedback={<SaveFeedback mutation={f.mutation} />}
    >
      {!f.server ? (
        <Skeleton variant="block" className="mt-6 h-40 w-full" />
      ) : (
        <Block>
          <Row label="Channel id" htmlFor="fb-channel" help={team ? `Empty uses the team default: ${team.name || team.id} (config/team.json).` : 'Empty uses the team default in config/team.json (none is set there yet).'} edited={f.changed('channelId')} error={idErr}>
            <TextInput id="fb-channel" width="sm" value={d.channelId ?? ''} placeholder="C0123ABCD" onChange={(e) => f.set('channelId', e.target.value.trim().toUpperCase())} aria-invalid={!!idErr} data-testid="fb-channel" />
          </Row>
          <Row label="Channel name" htmlFor="fb-channel-name" help="How the panel names it." edited={f.changed('channelName')}>
            <TextInput id="fb-channel-name" width="md" value={d.channelName ?? ''} placeholder="#command-center-feedback" onChange={(e) => f.set('channelName', e.target.value)} data-testid="fb-channel-name" />
          </Row>
          <Row
            label="Post live"
            htmlFor="fb-live"
            help={`On: Send posts the report as you (still a dry run while Settings ▸ Sending has dry run on). Off: Send shows the payload and copies the message.${live === undefined ? '' : live ? ' Send posts right now.' : ' Send is a dry run right now.'}`}
            edited={f.changed('postLive')}
          >
            <Switch id="fb-live" label="Post live" checked={d.postLive ?? true} onChange={(v) => f.set('postLive', v)} testId="fb-live" />
          </Row>
        </Block>
      )}
    </Section>
  );
}
