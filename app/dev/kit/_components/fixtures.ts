/**
 * /dev/kit fixtures, shaped like the sample-data world (sample-data/CAST.md): invented accounts and people only
 * (Saltmere Health, Elderglen Outdoors, Halvergate Freight, Ferrowpay; Marisol Quintero, Theo Brandt…). Never real
 * names, ids or links: every URL is example.com.
 */
export const NOW = '2026-11-18T16:00:00.000Z'; // Wed 18 Nov 09:00 MST, the sample world's "now"
export const TZ = 'America/Denver';

export interface KitRow {
  id: string;
  title: string;
  why: string;
  account: string;
  source: { label: string; url: string };
  confidence: 'sure' | 'likely' | 'guess';
  ai?: boolean;
}

export const ROWS: KitRow[] = [
  { id: 'wi-001', title: 'Send the Saltmere solution blueprint', why: 'Marisol asked for it by Friday in #saltmere-poc', account: 'Saltmere Health', source: { label: 'Open in Slack', url: 'https://example.com/slack/saltmere-poc/1' }, confidence: 'sure' },
  { id: 'wi-002', title: 'Book the Elderglen renewal demo', why: 'Theo asked in Slack 2 days ago; you said "this week"', account: 'Elderglen Outdoors', source: { label: 'Open in Slack', url: 'https://example.com/slack/elderglen/2' }, confidence: 'likely', ai: true },
  { id: 'wi-003', title: 'Nudge Anjali on the network-planning pilot', why: 'No reply in 9 days; next step was due Monday', account: 'Halvergate Freight', source: { label: 'Open in Gmail', url: 'https://example.com/mail/halvergate/3' }, confidence: 'guess' },
  { id: 'wi-004', title: 'Answer Folasade on fraud-model latency', why: 'She asked in the Ferrowpay channel this morning', account: 'Ferrowpay', source: { label: 'Open in Slack', url: 'https://example.com/slack/ferrowpay/4' }, confidence: 'sure' },
  { id: 'wi-005', title: 'Log the Saltmere architecture workshop', why: '2h on Tuesday has a suggested opp: Saltmere · Data 360 POC', account: 'Saltmere Health', source: { label: 'Open in Calendar', url: 'https://example.com/cal/saltmere/5' }, confidence: 'likely', ai: true },
];

export const ARRIVALS: KitRow[] = [
  { id: 'wi-101', title: 'Reply to Brendan about the holiday cut-over', why: 'Arrived just now from Gmail', account: 'Elderglen Outdoors', source: { label: 'Open in Gmail', url: 'https://example.com/mail/elderglen/101' }, confidence: 'likely', ai: true },
  { id: 'wi-102', title: 'Confirm Soo-jin joins the Thursday review', why: 'Arrived just now from Slack', account: 'Saltmere Health', source: { label: 'Open in Slack', url: 'https://example.com/slack/saltmere/102' }, confidence: 'sure' },
  { id: 'wi-103', title: 'Share the Halvergate pilot scorecard', why: 'Arrived just now from a meeting note', account: 'Halvergate Freight', source: { label: 'Open in Drive', url: 'https://example.com/drive/halvergate/103' }, confidence: 'guess' },
  { id: 'wi-104', title: 'Send Kwame the analytics sandbox link', why: 'Arrived just now from Slack', account: 'Elderglen Outdoors', source: { label: 'Open in Slack', url: 'https://example.com/slack/elderglen/104' }, confidence: 'likely' },
];

export interface KitDraft {
  id: string;
  to: string;
  where: string;
  text: string;
  why: string;
  confidence: 'sure' | 'likely' | 'guess';
  /** The fake adapter fails this one once (to show the Retry card). */
  fails?: boolean;
}

export const DRAFTS: KitDraft[] = [
  { id: 'dr-01', to: 'Marisol Quintero', where: 'Slack · #saltmere-poc · thread', text: 'Here is the blueprint draft. The member-360 model is on page 4; I left two questions for Soo-jin in the margin.', why: 'You promised it by Friday in the thread', confidence: 'sure' },
  { id: 'dr-02', to: 'Theo Brandt', where: 'Slack · DM', text: 'Thursday 10:00 works for the Elderglen demo. I will bring the loyalty journey and the agent hand-off.', why: 'Theo asked for a slot this week', confidence: 'sure' },
  { id: 'dr-03', to: 'Anjali Rao', where: 'Gmail · Re: pilot next steps', text: 'Checking in on the network-planning pilot: shall we move the readout to next Tuesday?', why: 'No reply in 9 days', confidence: 'likely', fails: true },
  { id: 'dr-04', to: 'Folasade Adeyemi', where: 'Slack · #ferrowpay-fraud', text: 'p95 scoring latency in the sandbox is 120 ms; I can show the trace on Friday.', why: 'She asked this morning', confidence: 'guess' },
];

export const SECTIONS_TEXT = {
  why: 'Marisol asked for it in #saltmere-poc on Tuesday and you replied "by Friday". The POC readout is next Wednesday.',
  next: 'Finish page 4 (member-360 model), then send it in the thread.',
  evidence: ['Tue 09:12 · Marisol: "Could we see the blueprint before the readout?"', 'Tue 09:40 · You: "Yes, by Friday."', 'Wed 08:05 · Calendar: Saltmere POC readout, Wed 25 Nov'],
};
