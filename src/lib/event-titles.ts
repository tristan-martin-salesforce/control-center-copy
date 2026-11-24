/**
 * What a calendar event is from its title alone: a flight, a hotel stay, an onsite, a customer dinner, a non-meeting
 * block. Pure regexes in the shared layer so the Calendar connector and the activity engine agree without the
 * connector importing an engine (CONTRIBUTING "Where code goes"). `src/engines/activity/event-kinds.ts` re-exports
 * every name and adds the shape checks (spans, markers).
 *
 * A flight is an airline flight number ("UA 100") or a title that starts "Flight to/from …", never the bare word:
 * a restaurant called "… Flight Club" is a dinner, not a flight (onsite lane, root cause 3).
 */

/** IATA airline codes seen on US business travel; a code plus 1–4 digits is a flight number. */
const FLIGHT_NUMBER = /\b(?:AA|AC|AF|AM|AS|AV|B6|BA|CM|CX|DL|EI|EK|F9|G4|HA|IB|JL|KL|LA|LH|LX|NH|NK|NZ|QF|QR|SQ|SY|TK|UA|VS|WN|WS)\s?\d{1,4}\b/;
const FLIGHT_LEAD = /^\s*(?:✈️?\s*)?flight\s+(?:to|from|home|back)\b/i;
const AIRLINE = /\b(?:united airlines|united flight|delta|american airlines|southwest|alaska airlines|jetblue|frontier airlines|spirit airlines|air canada|westjet|british airways|lufthansa)\b/i;
const PLANE = /✈/;

const HOTEL = /^\s*(?:stay at|hotel stay|check-?in:?\s)|\b(?:hotel|marriott|hilton|hyatt|sheraton|westin|embassy suites|hampton inn|courtyard by|doubletree|holiday inn|ritz-carlton|four seasons|kimpton|airbnb)\b/i;
const ONSITE = /\b(?:on-?site|in[- ]person|customer visit|site visit|onsite visit)\b/i;
const DINNER = /\b(?:dinner|happy hour|reception|customer lunch|team lunch with)\b/i;
const HOME_WORDS = /^\s*(?:home|office|remote|working from home|wfh)\s*$/i;

export const isFlightTitle = (title: string): boolean => FLIGHT_NUMBER.test(title) || FLIGHT_LEAD.test(title) || PLANE.test(title) || (AIRLINE.test(title) && /\bflight\b/i.test(title));
export const isHotelTitle = (title: string): boolean => HOTEL.test(title);
export const isOnsiteTitle = (title: string): boolean => ONSITE.test(title);
export const isDinnerTitle = (title: string): boolean => DINNER.test(title);
export const isHomeWord = (title: string): boolean => HOME_WORDS.test(title);

/** The flight number in a title ("UA 200"), normalized without the space; null when there is none. */
export function flightNumber(title: string): string | null {
  const m = FLIGHT_NUMBER.exec(title);
  return m ? m[0].replace(/\s+/g, '') : null;
}

/**
 * Titles of blocks that are not meetings even with a guest list (focus, holds, travel, hotel stays). The Calendar
 * fetcher uses it to mark attendance n/a. "flight" alone is not in it: only a real flight (isFlightTitle) is.
 */
const NON_MEETING_WORDS = /\b(focus time|focus block|busy|hold|block|travel|commute|lunch|ooo|out of office|stay at|hotel|reservation)\b/i;
export const isNonMeetingTitle = (title: string): boolean => NON_MEETING_WORDS.test(title) || isFlightTitle(title);
