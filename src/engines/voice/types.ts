import { z } from 'zod';

/**
 * Voice profile: how the user writes, learned from his sent Slack messages (he rarely emails).
 * The DB-aligned fields map 1:1 to `voice_profiles` (DATA-MODEL §1); `stats`, `audiences` and
 * `exemplars` are extra detail kept in the local JSON profile and rendered into prompts.
 *
 * The real profile lives only at ~/Library/Application Support/command-center/voice/profile.json
 * (chmod 600). The repo carries a placeholder example only.
 */

export type ChannelType = 'dm' | 'group_dm' | 'channel';
export type Audience = 'dm' | 'group' | 'channel' | 'account_channel' | 'external';
export const AUDIENCES: Audience[] = ['dm', 'group', 'channel', 'account_channel', 'external'];

export interface SentMessage {
  ts: string;
  at: string;
  channelId: string;
  channelType: ChannelType;
  channelName?: string;
  participants?: Array<{ name: string; id: string }>;
  authorId?: string;
  text: string;
  threadTs?: string;
  permalink?: string;
  replyCount?: number;
}

const share = z.number().min(0).max(1);

export const audienceStatsSchema = z.object({
  count: z.number().int().min(0),
  medianWords: z.number().min(0),
  p75Words: z.number().min(0),
  shareEmoji: share,
  shareQuestion: share,
  shareGreeting: share,
  shareBullets: share,
});
export type AudienceStats = z.infer<typeof audienceStatsSchema>;

export const voiceProfileSchema = z.object({
  schemaVersion: z.literal(1),
  userLabel: z.string().min(1),
  source: z.enum(['slack_sent', 'user', 'example']),
  builtAt: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  learnedFromMessageCount: z.number().int().min(0),
  excluded: z.object({ empty: z.number().int(), linkOnly: z.number().int(), longForm: z.number().int(), secrets: z.number().int() }),

  // ---- voice_profiles columns ----
  tone: z.string().min(3).max(300),
  /** 1 casual … 5 formal */
  formality: z.number().int().min(1).max(5),
  /** 1 terse … 5 thorough */
  verbosity: z.number().int().min(1).max(5),
  /** 0 never … 3 often */
  emojiUse: z.number().int().min(0).max(3),
  greeting: z.string().nullable(),
  signoff: z.string().nullable(),
  phrasesToUse: z.array(z.string()).max(20),
  phrasesToAvoid: z.array(z.string()).max(20),
  styleGuide: z.string().max(1500),
  slackGuide: z.string().max(1500),
  emailGuide: z.string().max(1500),
  customerGuide: z.string().max(1000),

  // ---- detail ----
  stats: z.object({
    words: z.object({ p25: z.number(), median: z.number(), p75: z.number(), p90: z.number() }),
    shareOneLine: share,
    shareMultiParagraph: share,
    shareBullets: share,
    shareNumbered: share,
    shareMention: share,
    shareStartsWithMention: share,
    shareEmoji: share,
    topEmoji: z.array(z.string()).max(10),
    shareLinks: share,
    shareQuestion: share,
    shareExclamation: share,
    shareLowercaseStart: share,
    shareEndsWithPeriod: share,
    semicolonsPer100Words: z.number().min(0),
    shareParenthetical: share,
    contractionsPer100Words: z.number().min(0),
    shareLongForm: share,
    abbreviations: z.array(z.object({ term: z.string(), count: z.number().int() })).max(15),
  }),
  greetings: z.array(z.object({ form: z.string(), count: z.number().int() })).max(8),
  openers: z.array(z.object({ word: z.string(), share })).max(12),
  signatures: z.array(z.object({ phrase: z.string(), count: z.number().int() })).max(20),
  commonPhrases: z.array(z.object({ phrase: z.string(), count: z.number().int() })).max(25),
  audiences: z.record(z.string(), audienceStatsSchema),
  exemplars: z.array(z.object({ audience: z.enum(['dm', 'group', 'channel', 'account_channel', 'external']), text: z.string().max(300) })).max(15),
  synthesized: z.object({ model: z.string(), at: z.string() }).nullable().default(null),
});

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;
