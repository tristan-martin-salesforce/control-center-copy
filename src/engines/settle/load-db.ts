/**
 * Reads the Settle pass's raw rows from Postgres (read-only): the item, its evidence, the conversation around its
 * origin (Slack thread or DM / channel window, or the email thread), my later messages and the asker's elsewhere,
 * calendar events around the topic, and sibling items. Pure assembly lives in context.ts.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { cutHead } from '@/engines/prompt-cut';

import { SOURCE_EXCERPT_MAX, type RawEvent, type RawItem, type RawSibling, type RawSource, type SettleRaw } from './context';

type Row = Record<string, unknown>;
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
const textArr = (vals: string[]): SQL => (vals.length ? sql`array[${sql.join(vals.map((v) => sql`${v}::text`), sql`, `)}]` : sql`array[]::text[]`);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());

const SOURCE_COLS = sql`si.id::text as id, si.source::text as source, si.kind::text as kind, si.external_id, si.external_parent_id as parent, si.url,
  si.occurred_at, si.from_me, si.addressed_to_me, si.title, (length(si.body) >= ${SOURCE_EXCERPT_MAX}) as cut,
  left(concat_ws(' ', si.body, (case when jsonb_typeof(si.meta->'files') = 'array' then '[attached: ' || (select string_agg(f->>'name', ', ') from jsonb_array_elements(si.meta->'files') f) || ']' when si.meta->>'hasFile' = 'true' then '[attached: a file]' end)), 1200) as text,
  coalesce(si.meta->'author'->>'name', si.meta->'from'->>'name', si.meta->>'from') as author,
  si.meta->>'channelId' as channel_id, si.meta->>'channelType' as channel_type, si.meta->>'channelName' as channel_name,
  si.meta->>'threadTs' as thread_ts, si.meta->>'ts' as ts,
  (si.meta->>'repliedByMe')::boolean as replied_by_me, (si.meta->>'lastMessageFromMe')::boolean as last_from_me,
  (si.meta->>'bulk')::boolean as bulk, (select rr->>'response' from jsonb_array_elements(case when jsonb_typeof(si.meta->'responses') = 'array' then si.meta->'responses' else '[]'::jsonb end) rr
     where lower(rr->>'email') = (select lower(u.email) from users u where u.id = si.owner_user_id) limit 1) as my_response, (si.meta->>'attendeeCount')::int as attendee_count,
  (select array_agg(pp->>'name') from jsonb_array_elements(case when jsonb_typeof(si.meta->'participants') = 'array' then si.meta->'participants' else '[]'::jsonb end) pp
    where coalesce((pp->>'isMe')::boolean, false) = false and pp->>'name' is not null) as parts`;

function source(r: Row): RawSource {
  return {
    id: String(r.id),
    source: String(r.source),
    kind: String(r.kind),
    externalId: String(r.external_id),
    parent: (r.parent as string) ?? null,
    url: (r.url as string) ?? null,
    at: iso(r.occurred_at)!,
    fromMe: !!r.from_me,
    addressedToMe: (r.addressed_to_me as boolean | null) ?? null,
    title: (r.title as string) ?? null,
    text: (r.text as string) ?? null,
    author: (r.author as string) ?? null,
    channelId: (r.channel_id as string) ?? null,
    channelType: (r.channel_type as string) ?? null,
    channelName: (r.channel_name as string) ?? null,
    threadTs: (r.thread_ts as string) ?? null,
    ts: (r.ts as string) ?? null,
    repliedByMe: (r.replied_by_me as boolean | null) ?? null,
    lastFromMe: (r.last_from_me as boolean | null) ?? null,
    ...(r.bulk ? { bulk: true } : {}),
    ...(r.cut ? { cut: true } : {}),
    ...(r.my_response ? { myResponse: String(r.my_response) } : {}),
    ...(r.attendee_count != null ? { attendeeCount: Number(r.attendee_count) } : {}),
    ...(Array.isArray(r.parts) && r.parts.length ? { participants: (r.parts as string[]).filter(Boolean) } : {}),
    ...(r.role ? { role: String(r.role) } : {}),
  };
}

/** Words too common in company domains to tie a meeting to one customer. */
const GENERIC_DOMAIN_WORDS = new Set('health healthcare group solutions systems services global partners company corporation international technologies digital network networks plans insurance mutual national american united first'.split(' '));

const STOP = new Set(
  'with from that this have your about into what when will just they them their there were been need needs needed confirm review share send reply answer update follow followup check help find give make take today tomorrow before after call meeting for and the you can our out get set'.split(' '),
);

/** Salient title words for the elsewhere / event / sibling searches (names and topics, not verbs). */
export function salientWords(title: string, extra: Array<string | null | undefined> = []): string[] {
  const words = `${title} ${extra.filter(Boolean).join(' ')}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, 8);
}

export interface LoadOptions {
  now: Date;
}

export async function loadSettleRaw(db: Db, userId: string, itemId: string, o: LoadOptions): Promise<SettleRaw | null> {
  const it = rows<Row>(
    await db.execute(sql`
      select wi.id::text as id, wi.kind::text as kind, wi.status::text as status, wi.title, wi.purpose, wi.description, wi.due_at, wi.created_at,
             cp.display_name as counterparty, a.name as account
        from work_items wi left join people cp on cp.id = wi.counterparty_person_id left join accounts a on a.id = wi.account_id
       where wi.owner_user_id = ${userId} and wi.id = ${itemId}::uuid`),
  )[0];
  if (!it) return null;
  const item: RawItem = {
    id: String(it.id),
    kind: String(it.kind),
    status: String(it.status),
    title: String(it.title),
    purpose: (it.purpose as string) ?? null,
    description: (it.description as string) ?? null,
    dueAt: iso(it.due_at),
    createdAt: iso(it.created_at)!,
    counterparty: (it.counterparty as string) ?? null,
    account: (it.account as string) ?? null,
  };
  const evidence = rows<Row>(
    await db.execute(sql`
      select e.role::text as role, ${SOURCE_COLS}
        from work_item_evidence e join source_items si on si.id = e.source_item_id
       where e.work_item_id = ${itemId}::uuid
       order by si.occurred_at`),
  ).map(source);
  const origins = evidence.filter((e) => e.role === 'origin');
  const ask = origins[0] ?? evidence[0];
  const nowIso = o.now.toISOString();

  // The conversation around the ask.
  let conversation: RawSource[] = [];
  if (ask?.source === 'slack' && ask.channelId) {
    const askAt = ask.at;
    if (ask.threadTs) {
      conversation = rows<Row>(
        await db.execute(sql`
          select ${SOURCE_COLS} from source_items si
           where si.owner_user_id = ${userId} and si.source = 'slack' and si.meta->>'channelId' = ${ask.channelId}
             and (si.meta->>'threadTs' = ${ask.threadTs} or si.meta->>'ts' = ${ask.threadTs})
           order by si.occurred_at limit 200`),
      ).map(source);
    } else {
      const isDm = ask.channelType === 'im' || ask.channelType === 'mpim';
      conversation = rows<Row>(
        await db.execute(sql`
          select ${SOURCE_COLS} from source_items si
           where si.owner_user_id = ${userId} and si.source = 'slack' and si.meta->>'channelId' = ${ask.channelId}
             and si.occurred_at >= ${askAt}::timestamptz - interval '3 days'
             and si.occurred_at <= least(${nowIso}::timestamptz, ${askAt}::timestamptz + (case when ${isDm} then interval '45 days' else interval '10 days' end))
             and (si.meta->>'threadTs' is null or si.meta->>'threadTs' = ${ask.ts ?? ''})
           order by si.occurred_at limit 200`),
      ).map(source);
    }
  } else if (ask?.source === 'gmail' && ask.parent) {
    conversation = rows<Row>(
      await db.execute(sql`
        select ${SOURCE_COLS} from source_items si
         where si.owner_user_id = ${userId} and si.source = 'gmail' and si.external_parent_id = ${ask.parent}
         order by si.occurred_at limit 60`),
    ).map(source);
  }

  const words = salientWords(item.title, [item.counterparty, item.account]);
  const tsq = words.length ? words.join(' or ') : null;
  const askAt = ask?.at ?? item.createdAt;
  const convIds = conversation.map((r) => r.id);

  // The people around the ask: the asker, the counterparty, people named in the title, and (for meeting notes and
  // small group DMs) the other participants. Names match Slack authors and participants; emails match calendar
  // attendees.
  const dir = await loadDirectory(db, userId);
  const names = new Set<string>();
  if (ask?.author && !ask.fromMe) names.add(ask.author);
  if (item.counterparty) names.add(item.counterparty);
  const askParts = ask ? rows<Row>(await db.execute(sql`select meta->'participants' as p from source_items where id = ${ask.id}::uuid`))[0] : undefined;
  const parts = Array.isArray(askParts?.p) ? (askParts!.p as Array<{ name?: string; email?: string; isMe?: boolean }>).filter((x) => !x.isMe) : [];
  if (parts.length && parts.length <= 6) for (const x of parts) if (x.name) names.add(x.name);
  for (const n of namesInTitle(item.title, dir)) names.add(n);
  const emails = new Set<string>(parts.length <= 8 ? parts.map((x) => x.email?.toLowerCase()).filter((e): e is string => !!e) : []);
  for (const n of names) for (const e of emailsFor(n, dir)) emails.add(e);
  // Meeting notes list attendees by email: name them from the directory so their Slack DMs count too.
  if (parts.length && parts.length <= 8)
    for (const x of parts) {
      const e = x.email?.toLowerCase();
      if (!e) continue;
      for (const [n, set] of dir.emailsByName) if (set.has(e)) names.add(dir.names.find((d) => d.toLowerCase() === n) ?? n);
      const local = e.split('@')[0] ?? '';
      if (e.endsWith('@salesforce.com') && local.includes('.')) {
        const guess = local.split('.').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
        const real = dir.names.find((d) => d.toLowerCase() === guess.toLowerCase());
        if (real) names.add(real);
      }
    }
  const nameList = [...names];
  const kw = new Set(words);
  const overlap = (t: string | null | undefined) => {
    const ws = new Set((t ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/));
    let n = 0;
    for (const w of kw) if (ws.has(w)) n += 1;
    return n;
  };

  // Elsewhere: after the ask, outside the conversation. (a) my messages and theirs in DMs / group DMs with these
  // people, (b) my messages anywhere on the topic, (c) the asker's messages on the topic. Scored, best 10 kept.
  const pool = new Map<string, RawSource>();
  const add = (rs: Row[]) => {
    for (const r of rs) {
      const x = source(r);
      if (!convIds.includes(x.id) && x.id !== ask?.id) pool.set(x.id, x);
    }
  };
  if (nameList.length) {
    add(
      rows<Row>(
        await db.execute(sql`
          select ${SOURCE_COLS} from source_items si
           where si.owner_user_id = ${userId} and si.source = 'slack' and si.meta->>'channelType' in ('im', 'mpim')
             and si.occurred_at > ${askAt}::timestamptz and si.occurred_at <= least(${nowIso}::timestamptz, ${askAt}::timestamptz + interval '21 days')
             and (coalesce(si.meta->'author'->>'name', '') = any(${textArr(nameList)})
                  or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(si.meta->'participants') = 'array' then si.meta->'participants' else '[]'::jsonb end) pp
                              where pp->>'name' = any(${textArr(nameList)})))
           order by si.occurred_at limit 120`),
      ),
    );
  }
  if (tsq) {
    add(
      rows<Row>(
        await db.execute(sql`
          select ${SOURCE_COLS} from source_items si
           where si.owner_user_id = ${userId} and si.source in ('slack', 'gmail')
             and (si.from_me ${nameList.length ? sql`or coalesce(si.meta->'author'->>'name', si.meta->'from'->>'name', '') = any(${textArr(nameList)})` : sql``})
             and si.occurred_at > ${askAt}::timestamptz and si.occurred_at <= ${nowIso}::timestamptz
             and si.search_tsv @@ websearch_to_tsquery('english', ${tsq})
           order by ts_rank(si.search_tsv, websearch_to_tsquery('english', ${tsq})) desc limit 30`),
      ),
    );
  }
  const askMs = Date.parse(askAt);
  const named = new Set(nameList.map((x) => x.toLowerCase()));
  const withNamed = (x: RawSource) => (x.author && !x.fromMe && named.has(x.author.toLowerCase())) || (x.participants ?? []).some((n) => named.has(n.toLowerCase()));
  // My first three messages to each named person after the ask (a delivery is often a bare link, with no topic words).
  const firstMine = new Set<string>();
  const perConv = new Map<string, number>();
  for (const x of [...pool.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!x.fromMe || !withNamed(x) || !x.channelId) continue;
    const k = x.channelId;
    const n = perConv.get(k) ?? 0;
    if (n < 3) firstMine.add(x.id);
    perConv.set(k, n + 1);
  }
  const scoreOf = (x: RawSource) => {
    const ov = overlap(`${x.title ?? ''} ${x.text ?? ''}`);
    const soon = Date.parse(x.at) - askMs <= 2 * 86_400_000 ? 1 : 0;
    const dm = withNamed(x) ? (x.channelType === 'im' ? 3 : x.channelType === 'mpim' ? 1 : 0) : 0;
    return ov * 2 + (x.fromMe ? 1 : 0) + soon + dm + (firstMine.has(x.id) ? 2 : 0);
  };
  const elsewhere = cutHead(
    'settle.load.elsewhere',
    [...pool.values()]
      .map((x) => ({ x, s: scoreOf(x) }))
      .filter((e) => e.s >= 3)
      .sort((a, b) => b.s - a.s || Date.parse(a.x.at) - Date.parse(b.x.at)),
    14,
  ).map((e) => e.x);

  // Calendar events between a day before the ask and two days from now: on the topic, or with these people.
  const events: RawEvent[] = [];
  // A meeting with the customer counts even when its title shares no words with the item: match the account's (or the
  // title's) distinctive words against external attendee domains ("priority" → priorityhealth.com).
  const domainLike = [...new Set([...salientWords(item.account ?? '', []), ...words])].filter((w) => w.length >= 5 && !GENERIC_DOMAIN_WORDS.has(w)).map((w) => `%${w}%`);
  if (words.length || emails.size || nameList.length || domainLike.length) {
    const like = words.map((w) => `%${w}%`);
    const evRows = rows<Row>(
      await db.execute(sql`
        select ce.id::text as id, ce.title, ce.starts_at, ce.ends_at, ce.status::text as status, ce.my_response::text as my_response,
               ce.attendance::text as attendance, ce.is_all_day,
               (select count(*) from calendar_event_attendees at where at.calendar_event_id = ce.id) as n_att,
               (select count(*) from calendar_event_attendees at where at.calendar_event_id = ce.id
                   and (lower(at.email) = any(${textArr([...emails].map((e) => e.toLowerCase()))}) or at.display_name = any(${textArr(nameList)}))) as n_people,
               (select min(split_part(lower(at.email), '@', 2)) from calendar_event_attendees at where at.calendar_event_id = ce.id
                   and split_part(lower(at.email), '@', 2) like any(${textArr(domainLike.length ? domainLike : ['-'])}) and split_part(lower(at.email), '@', 2) not like '%salesforce%') as with_domain
          from calendar_events ce
         where ce.owner_user_id = ${userId} and ce.deleted_upstream_at is null
           and ce.starts_at >= ${askAt}::timestamptz - interval '1 day' and ce.starts_at <= ${nowIso}::timestamptz + interval '2 days'
           and (${like.length ? sql`ce.title ilike any(${textArr(like)})` : sql`false`}
                or exists (select 1 from calendar_event_attendees at where at.calendar_event_id = ce.id
                             and (lower(at.email) = any(${textArr([...emails].map((e) => e.toLowerCase()))}) or at.display_name = any(${textArr(nameList)})))
                or (${domainLike.length > 0} and exists (select 1 from calendar_event_attendees at where at.calendar_event_id = ce.id
                             and split_part(lower(at.email), '@', 2) like any(${textArr(domainLike)}) and split_part(lower(at.email), '@', 2) not like '%salesforce%')))
         order by ce.starts_at limit 60`),
    );
    const ranked = evRows
      .map((r) => {
        const people = Number(r.n_people ?? 0);
        const att = Number(r.n_att ?? 0);
        const s = overlap(String(r.title ?? '')) * 2 + (people ? 2 : 0) + (people && att && att <= 6 ? 1 : 0) + (r.with_domain ? 3 : 0);
        return { r, s };
      })
      .filter((e) => e.s >= 2)
      .sort((a, b) => b.s - a.s || Date.parse(String(a.r.starts_at)) - Date.parse(String(b.r.starts_at)));
    const scored = cutHead('settle.load.events', ranked, 8);
    events.push(
      ...scored.map(({ r }) => ({
        id: String(r.id),
        title: String(r.title ?? ''),
        startsAt: iso(r.starts_at)!,
        endsAt: iso(r.ends_at)!,
        status: (r.status as string) ?? null,
        myResponse: (r.my_response as string) ?? null,
        attendance: (r.attendance as string) ?? null,
        allDay: !!r.is_all_day,
        ...(r.with_domain ? { withDomain: String(r.with_domain) } : {}),
      })),
    );
  }

  // Siblings: items from the same conversation, then items with a similar title created within three weeks.
  const conversationKey = ask?.source === 'slack' && ask.channelId ? (ask.threadTs ? { ch: ask.channelId, thread: ask.threadTs } : { ch: ask.channelId, thread: null }) : null;
  const siblings: RawSibling[] = [];
  if (conversationKey) {
    siblings.push(
      ...rows<Row>(
        await db.execute(sql`
          select distinct on (w.id) w.id::text as id, w.title, w.status::text as status, w.resolution::text as resolution, w.created_at
            from work_items w join work_item_evidence e on e.work_item_id = w.id and e.role = 'origin' join source_items si on si.id = e.source_item_id
           where w.owner_user_id = ${userId} and w.id <> ${itemId}::uuid and si.meta->>'channelId' = ${conversationKey.ch}
             ${conversationKey.thread ? sql`and (si.meta->>'threadTs' = ${conversationKey.thread} or si.meta->>'ts' = ${conversationKey.thread})` : sql`and si.occurred_at between ${askAt}::timestamptz - interval '7 days' and ${askAt}::timestamptz + interval '7 days'`}
           limit 6`),
      ).map((r) => ({ id: String(r.id), title: String(r.title), status: String(r.status), resolution: (r.resolution as string) ?? null, createdAt: iso(r.created_at)!, sameConversation: true })),
    );
  }
  if (tsq) {
    const have = new Set(siblings.map((s) => s.id));
    siblings.push(
      ...rows<Row>(
        await db.execute(sql`
          select w.id::text as id, w.title, w.status::text as status, w.resolution::text as resolution, w.created_at
            from work_items w
           where w.owner_user_id = ${userId} and w.id <> ${itemId}::uuid
             and w.created_at between ${item.createdAt}::timestamptz - interval '21 days' and ${item.createdAt}::timestamptz + interval '21 days'
             and w.search_tsv @@ websearch_to_tsquery('english', ${tsq})
           order by ts_rank(w.search_tsv, websearch_to_tsquery('english', ${tsq})) desc limit 6`),
      )
        .map((r) => ({ id: String(r.id), title: String(r.title), status: String(r.status), resolution: (r.resolution as string) ?? null, createdAt: iso(r.created_at)!, sameConversation: false }))
        .filter((s) => !have.has(s.id)),
    );
  }

  return { item, evidence, conversation, elsewhere, events, siblings, keywords: words };
}

/** Names and emails seen in the sources (the people table may be empty before authors are resolved). */
export interface Directory {
  names: string[];
  emailsByName: Map<string, Set<string>>;
  attendeeEmails: Set<string>;
}
const dirCache = new Map<string, { at: number; dir: Directory }>();

export async function loadDirectory(db: Db, userId: string): Promise<Directory> {
  const hit = dirCache.get(userId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.dir;
  const names = rows<{ n: string }>(
    await db.execute(sql`
      select distinct n from (
        select si.meta->'author'->>'name' as n from source_items si where si.owner_user_id = ${userId} and si.source = 'slack' and not si.from_me
        union all
        select pp->>'name' from source_items si, jsonb_array_elements(case when jsonb_typeof(si.meta->'participants') = 'array' then si.meta->'participants' else '[]'::jsonb end) pp
         where si.owner_user_id = ${userId} and si.source = 'slack' and coalesce((pp->>'isMe')::boolean, false) = false) x
       where n is not null and n <> ''`),
  ).map((r) => r.n);
  const emailsByName = new Map<string, Set<string>>();
  for (const r of rows<{ f: string }>(await db.execute(sql`select distinct si.meta->>'from' as f from source_items si where si.owner_user_id = ${userId} and si.source = 'gmail' and si.meta->>'from' like '%<%>%'`))) {
    const m = /^\s*"?([^"<]+?)"?\s*<([^>]+)>/.exec(r.f);
    if (!m) continue;
    const key = m[1]!.trim().toLowerCase();
    const set = emailsByName.get(key) ?? new Set<string>();
    set.add(m[2]!.trim().toLowerCase());
    emailsByName.set(key, set);
  }
  const attendeeEmails = new Set(rows<{ e: string }>(await db.execute(sql`select distinct lower(a.email) as e from calendar_event_attendees a join calendar_events ce on ce.id = a.calendar_event_id where ce.owner_user_id = ${userId} and a.email is not null`)).map((r) => r.e));
  const dir = { names, emailsByName, attendeeEmails };
  dirCache.set(userId, { at: Date.now(), dir });
  return dir;
}

/** People whose first name (and last name, when several share it) appears in the title as a word. */
export function namesInTitle(title: string, dir: Pick<Directory, 'names'>): string[] {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ')} `;
  const byFirst = new Map<string, string[]>();
  for (const n of dir.names) {
    const first = n.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first.length < 3) continue;
    byFirst.set(first, [...(byFirst.get(first) ?? []), n]);
  }
  const out: string[] = [];
  for (const [first, ns] of byFirst) {
    if (!t.includes(` ${first} `) && !t.includes(` ${first}'s `)) continue;
    const withLast = ns.filter((n) => {
      const last = n.trim().split(/\s+/).slice(-1)[0]?.toLowerCase();
      return last && last !== first && t.includes(` ${last} `);
    });
    out.push(...(withLast.length ? withLast : ns.length <= 2 ? ns : []));
  }
  return [...new Set(out)].slice(0, 6);
}

/** Emails for a name: from email senders, else the usual company formats when a calendar invite used them. */
export function emailsFor(name: string, dir: Pick<Directory, 'emailsByName' | 'attendeeEmails'>): string[] {
  const known = dir.emailsByName.get(name.trim().toLowerCase());
  if (known?.size) return [...known];
  const parts = name.trim().toLowerCase().replace(/[^a-z\s-]/g, '').split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const [f, l] = [parts[0]!, parts[parts.length - 1]!];
  const guesses = [`${f}.${l}`, `${f[0]}${l}`, `${f}${l[0]}`, `${f}${l}`].map((u) => `${u}@salesforce.com`);
  return guesses.filter((g) => dir.attendeeEmails.has(g));
}

/**
 * Me and my timezone: the job's own user (R15: before, the first active user's, whoever the job ran for). Without an
 * id (operator scripts on a one-user install): the first active user.
 */
export async function loadSettleUser(db: Db, userId?: string): Promise<{ userId: string; me: string; timezone: string }> {
  const u = rows<Row>(
    await db.execute(
      userId
        ? sql`select id::text as id, display_name, timezone from users where id = ${userId}`
        : sql`select id::text as id, display_name, timezone from users where is_active order by created_at limit 1`,
    ),
  )[0];
  if (!u) throw new Error('no active user');
  return { userId: String(u.id), me: String(u.display_name), timezone: String(u.timezone ?? 'UTC') };
}
