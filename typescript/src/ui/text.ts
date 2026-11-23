// Every word the ui kit shows, in English and Bangla. A product passes its
// own overrides; anything it leaves out falls back to the language's default.
// Functions take numbers and dates already formatted for the locale.

export type UiLocale = 'en' | 'bn'

export interface UiText {
  /** The BCP 47 tag numbers and dates are formatted with. Bangla is `bn-BD-u-nu-beng`: Bengali digits on every runtime. */
  locale: string
  loading: string
  loadFailed: string
  retry: string
  cancel: string
  back: string
  none: string
  yes: string
  no: string

  // the copilot panel
  copilot: string
  conversation: string
  you: string
  assistant: string
  composerLabel: string
  composerPlaceholder: string
  composerHint: string
  send: string
  stop: string
  working: string
  errorGeneric: string

  // consent cards
  consentTitle: string
  confirm: string
  decline: string
  field: string
  before: string
  after: string
  details: string
  expiresIn: (minutes: string) => string
  expired: string
  cardStatus: Record<'waiting' | 'confirmed' | 'declined' | 'expired' | 'failed' | 'stale' | 'already_settled', string>
  cardNotFound: string
  cardBusy: string

  // approval cards and the inbox
  approvalTitle: string
  whoDecides: (who: string) => string
  openReview: string
  approvalStatus: Record<'waiting' | 'approved' | 'refused' | 'expired' | 'running' | 'executed' | 'failed' | 'stale' | 'withdrawn', string>
  approvalBadge: Record<'waiting' | 'approved' | 'refused' | 'expired' | 'running' | 'executed' | 'failed' | 'stale' | 'withdrawn', string>
  labelDecider: string
  labelAsked: string
  labelExpires: string
  labelDecided: string
  approvals: string
  approvalsWaiting: string
  approvalsAll: string
  noApprovals: string
  requestedBy: (who: string, when: string) => string
  expiresAt: (when: string) => string
  decidedAt: (who: string, when: string) => string
  approve: string
  refuse: string
  reason: string
  reasonRequired: string
  typeTarget: string
  typedTargetMismatch: string
  stepUpTitle: string
  stepUpMissing: string
  cannotDecide: string
  decideOutcome: Record<'approved' | 'refused' | 'expired' | 'already_decided' | 'not_found' | 'step_up_required' | 'step_up_failed', string>
  ranOk: string
  ranNot: (why: string) => string

  // actors
  actorTitle: (name: string) => string
  actorState: Record<'start' | 'collect' | 'confirm' | 'pending_approval' | 'done' | 'handoff' | 'cancelled' | 'expired', string>
  actorProgress: (filled: string, total: string) => string
  openForm: string

  // memory
  memoryTitle: string
  memorySuggested: string
  memoryConfirmed: string
  memoryPending: string
  noMemories: string
  noPending: string
  memoryScope: Record<'person' | 'tenant', string>
  memorySource: (unit: string, when: string) => string
  memoryConfirmedBy: (who: string, when: string) => string
  remember: string
  dontRemember: string
  forget: string
  forgetAsk: (text: string) => string
  memoryDecided: Record<'confirmed' | 'rejected' | 'forgotten', string>

  // connected apps
  connectedApps: string
  apps: string
  keys: string
  noApps: string
  noKeys: string
  clientStatus: Record<'known' | 'verified' | 'unverified', string>
  keyKind: Record<'personal' | 'service', string>
  connectedOn: (when: string) => string
  lastUsed: (when: string) => string
  neverUsed: string
  expiresOn: (when: string) => string
  revoke: string
  revokeAsk: (name: string) => string
  revoked: (name: string) => string

  // standing grants
  grantsTitle: string
  grantsHelp: string
  noGrants: string
  capability: string
  days: string
  dailyCap: string
  addGrant: string
  grantLeft: (left: string, cap: string) => string
  grantSaved: (name: string) => string
}

const en: UiText = {
  locale: 'en',
  loading: 'Loading',
  loadFailed: 'This could not be loaded.',
  retry: 'Try again',
  cancel: 'Cancel',
  back: 'Back',
  none: 'none',
  yes: 'Yes',
  no: 'No',

  copilot: 'Copilot',
  conversation: 'Conversation',
  you: 'You',
  assistant: 'Copilot',
  composerLabel: 'Message',
  composerPlaceholder: 'Ask a question or say what to do',
  composerHint: 'Enter sends. Shift and Enter starts a new line.',
  send: 'Send',
  stop: 'Stop',
  working: 'Working on it',
  errorGeneric: 'Something went wrong. Nothing else was done.',

  consentTitle: 'Confirm this change',
  confirm: 'Confirm',
  decline: 'Decline',
  field: 'Field',
  before: 'Now',
  after: 'After',
  details: 'Details',
  expiresIn: (m) => `Expires in ${m} min`,
  expired: 'Expired',
  cardStatus: {
    waiting: 'Waiting for you. Nothing has changed yet.',
    confirmed: 'Done.',
    declined: 'Declined. Nothing changed.',
    expired: 'Expired. Nothing changed.',
    failed: 'It did not run. Nothing changed.',
    stale: 'The record changed since this card was made. Nothing was done.',
    already_settled: 'This card was already answered.',
  },
  cardNotFound: 'This card is no longer on the thread.',
  cardBusy: 'The thread is answering another message. Try again in a moment.',

  approvalTitle: 'Needs approval',
  whoDecides: (who) => `Decided by ${who}`,
  openReview: 'Open the review',
  approvalStatus: {
    waiting: 'Waiting for a decision. Nothing has changed yet.',
    approved: 'Approved. It is about to run.',
    refused: 'Refused. Nothing changed.',
    expired: 'Expired. Nothing changed.',
    running: 'Approved and running.',
    executed: 'Approved and done.',
    failed: 'Approved, but it did not run.',
    stale: 'The record changed since the request. Nothing was done.',
    withdrawn: 'Withdrawn. Nothing changed.',
  },
  approvalBadge: { waiting: 'Waiting', approved: 'Approved', refused: 'Refused', expired: 'Expired', running: 'Running', executed: 'Done', failed: 'Failed', stale: 'Out of date', withdrawn: 'Withdrawn' },
  labelDecider: 'Who decides',
  labelAsked: 'Asked',
  labelExpires: 'Expires',
  labelDecided: 'Decided',
  approvals: 'Approvals',
  approvalsWaiting: 'Waiting',
  approvalsAll: 'All',
  noApprovals: 'Nothing waits for a decision.',
  requestedBy: (who, when) => `Asked by ${who}, ${when}`,
  expiresAt: (when) => `Expires ${when}`,
  decidedAt: (who, when) => `Decided by ${who}, ${when}`,
  approve: 'Approve',
  refuse: 'Refuse',
  reason: 'Reason',
  reasonRequired: 'Give a reason for the refusal.',
  typeTarget: 'Type the target to confirm',
  typedTargetMismatch: 'That does not match the target.',
  stepUpTitle: 'Verify it is you',
  stepUpMissing: 'This approval needs a verification step that this page does not offer.',
  cannotDecide: 'You cannot decide this request.',
  decideOutcome: {
    approved: 'Approved.',
    refused: 'Refused. Nothing changed.',
    expired: 'The request expired. Nothing changed.',
    already_decided: 'Someone already decided this request.',
    not_found: 'There is no such request.',
    step_up_required: 'Verify it is you first.',
    step_up_failed: 'The verification did not pass.',
  },
  ranOk: 'It ran.',
  ranNot: (why) => `It did not run: ${why}`,

  actorTitle: (name) => name,
  actorState: {
    start: 'Starting',
    collect: 'Collecting details',
    confirm: 'Ready for you to confirm',
    pending_approval: 'Waiting for approval',
    done: 'Done',
    handoff: 'Moved to the form',
    cancelled: 'Cancelled',
    expired: 'Expired',
  },
  actorProgress: (filled, total) => `${filled} of ${total} filled`,
  openForm: 'Continue in the form',

  memoryTitle: 'What we remember',
  memorySuggested: 'Suggested to remember. It is kept only if you confirm it.',
  memoryConfirmed: 'Remembered',
  memoryPending: 'Waiting for you',
  noMemories: 'Nothing is remembered.',
  noPending: 'No suggestions wait for you.',
  memoryScope: { person: 'About you', tenant: 'About your organisation' },
  memorySource: (unit, when) => `Suggested by ${unit}, ${when}`,
  memoryConfirmedBy: (who, when) => `Confirmed by ${who}, ${when}`,
  remember: 'Remember',
  dontRemember: 'Do not remember',
  forget: 'Forget',
  forgetAsk: (text) => `Forget "${text}"?`,
  memoryDecided: { confirmed: 'Remembered.', rejected: 'Not remembered.', forgotten: 'Forgotten.' },

  connectedApps: 'Connected apps',
  apps: 'Apps',
  keys: 'Keys',
  noApps: 'No app is connected.',
  noKeys: 'You have no keys.',
  clientStatus: { known: 'Known app', verified: 'Verified', unverified: 'Not verified' },
  keyKind: { personal: 'Personal key', service: 'Service key' },
  connectedOn: (when) => `Connected ${when}`,
  lastUsed: (when) => `Last used ${when}`,
  neverUsed: 'Not used yet',
  expiresOn: (when) => `Expires ${when}`,
  revoke: 'Revoke',
  revokeAsk: (name) => `Revoke ${name}? It stops working at once.`,
  revoked: (name) => `${name} is revoked.`,

  grantsTitle: 'Standing permissions',
  grantsHelp: 'Let the copilot make one kind of change without asking each time, for a set number of days and times a day. Approvals are never waived.',
  noGrants: 'The copilot asks you before every change.',
  capability: 'Change',
  days: 'Days',
  dailyCap: 'Times a day',
  addGrant: 'Allow',
  grantLeft: (left, cap) => `${left} of ${cap} left today`,
  grantSaved: (name) => `${name} is allowed.`,
}

const bn: UiText = {
  locale: 'bn-BD-u-nu-beng',
  loading: 'লোড হচ্ছে',
  loadFailed: 'লোড করা যায়নি।',
  retry: 'আবার চেষ্টা করুন',
  cancel: 'বাতিল',
  back: 'ফিরে যান',
  none: 'নেই',
  yes: 'হ্যাঁ',
  no: 'না',

  copilot: 'কোপাইলট',
  conversation: 'কথোপকথন',
  you: 'আপনি',
  assistant: 'কোপাইলট',
  composerLabel: 'বার্তা',
  composerPlaceholder: 'প্রশ্ন করুন বা কী করতে হবে বলুন',
  composerHint: 'Enter চাপলে পাঠানো হবে। Shift ও Enter চাপলে নতুন লাইন।',
  send: 'পাঠান',
  stop: 'থামান',
  working: 'কাজ চলছে',
  errorGeneric: 'কিছু একটা ভুল হয়েছে। আর কিছু করা হয়নি।',

  consentTitle: 'এই পরিবর্তনটি নিশ্চিত করুন',
  confirm: 'নিশ্চিত করুন',
  decline: 'না করুন',
  field: 'ঘর',
  before: 'এখন',
  after: 'পরে',
  details: 'বিস্তারিত',
  expiresIn: (m) => `${m} মিনিট পর মেয়াদ শেষ`,
  expired: 'মেয়াদ শেষ',
  cardStatus: {
    waiting: 'আপনার অপেক্ষায়। এখনো কিছু বদলায়নি।',
    confirmed: 'সম্পন্ন।',
    declined: 'না করা হয়েছে। কিছু বদলায়নি।',
    expired: 'মেয়াদ শেষ। কিছু বদলায়নি।',
    failed: 'চালানো যায়নি। কিছু বদলায়নি।',
    stale: 'কার্ডটি তৈরির পর রেকর্ডটি বদলেছে। কিছু করা হয়নি।',
    already_settled: 'এই কার্ডের উত্তর আগেই দেওয়া হয়েছে।',
  },
  cardNotFound: 'এই কার্ডটি আর এই কথোপকথনে নেই।',
  cardBusy: 'কথোপকথনটি অন্য একটি বার্তার উত্তর দিচ্ছে। একটু পরে আবার চেষ্টা করুন।',

  approvalTitle: 'অনুমোদন দরকার',
  whoDecides: (who) => `সিদ্ধান্ত নেবেন: ${who}`,
  openReview: 'পর্যালোচনা খুলুন',
  approvalStatus: {
    waiting: 'সিদ্ধান্তের অপেক্ষায়। এখনো কিছু বদলায়নি।',
    approved: 'অনুমোদিত। এখনই চলবে।',
    refused: 'নাকচ। কিছু বদলায়নি।',
    expired: 'মেয়াদ শেষ। কিছু বদলায়নি।',
    running: 'অনুমোদিত, চলছে।',
    executed: 'অনুমোদিত ও সম্পন্ন।',
    failed: 'অনুমোদিত, কিন্তু চালানো যায়নি।',
    stale: 'অনুরোধের পর রেকর্ডটি বদলেছে। কিছু করা হয়নি।',
    withdrawn: 'প্রত্যাহার করা হয়েছে। কিছু বদলায়নি।',
  },
  approvalBadge: { waiting: 'অপেক্ষমাণ', approved: 'অনুমোদিত', refused: 'নাকচ', expired: 'মেয়াদ শেষ', running: 'চলছে', executed: 'সম্পন্ন', failed: 'ব্যর্থ', stale: 'পুরোনো', withdrawn: 'প্রত্যাহার' },
  labelDecider: 'কে সিদ্ধান্ত নেবেন',
  labelAsked: 'অনুরোধ',
  labelExpires: 'মেয়াদ',
  labelDecided: 'সিদ্ধান্ত',
  approvals: 'অনুমোদন',
  approvalsWaiting: 'অপেক্ষমাণ',
  approvalsAll: 'সব',
  noApprovals: 'কোনো সিদ্ধান্ত বাকি নেই।',
  requestedBy: (who, when) => `অনুরোধ করেছেন ${who}, ${when}`,
  expiresAt: (when) => `মেয়াদ শেষ ${when}`,
  decidedAt: (who, when) => `সিদ্ধান্ত নিয়েছেন ${who}, ${when}`,
  approve: 'অনুমোদন দিন',
  refuse: 'নাকচ করুন',
  reason: 'কারণ',
  reasonRequired: 'নাকচ করার কারণ লিখুন।',
  typeTarget: 'নিশ্চিত করতে লক্ষ্যটি টাইপ করুন',
  typedTargetMismatch: 'এটি লক্ষ্যের সঙ্গে মেলে না।',
  stepUpTitle: 'যাচাই করুন যে এটি আপনি',
  stepUpMissing: 'এই অনুমোদনের জন্য যে যাচাই দরকার, এই পাতায় তা নেই।',
  cannotDecide: 'এই অনুরোধে আপনি সিদ্ধান্ত নিতে পারবেন না।',
  decideOutcome: {
    approved: 'অনুমোদিত।',
    refused: 'নাকচ। কিছু বদলায়নি।',
    expired: 'অনুরোধের মেয়াদ শেষ। কিছু বদলায়নি।',
    already_decided: 'এই অনুরোধে আগেই সিদ্ধান্ত হয়েছে।',
    not_found: 'এমন কোনো অনুরোধ নেই।',
    step_up_required: 'আগে যাচাই করুন যে এটি আপনি।',
    step_up_failed: 'যাচাই সফল হয়নি।',
  },
  ranOk: 'চালানো হয়েছে।',
  ranNot: (why) => `চালানো যায়নি: ${why}`,

  actorTitle: (name) => name,
  actorState: {
    start: 'শুরু হচ্ছে',
    collect: 'তথ্য নেওয়া হচ্ছে',
    confirm: 'আপনার নিশ্চিত করার অপেক্ষায়',
    pending_approval: 'অনুমোদনের অপেক্ষায়',
    done: 'সম্পন্ন',
    handoff: 'ফর্মে পাঠানো হয়েছে',
    cancelled: 'বাতিল',
    expired: 'মেয়াদ শেষ',
  },
  actorProgress: (filled, total) => `${total}টির মধ্যে ${filled}টি পূরণ হয়েছে`,
  openForm: 'ফর্মে চালিয়ে যান',

  memoryTitle: 'আমরা যা মনে রাখি',
  memorySuggested: 'মনে রাখার প্রস্তাব। আপনি নিশ্চিত করলেই রাখা হবে।',
  memoryConfirmed: 'মনে রাখা হয়েছে',
  memoryPending: 'আপনার অপেক্ষায়',
  noMemories: 'কিছুই মনে রাখা নেই।',
  noPending: 'কোনো প্রস্তাব আপনার অপেক্ষায় নেই।',
  memoryScope: { person: 'আপনার বিষয়ে', tenant: 'আপনার প্রতিষ্ঠানের বিষয়ে' },
  memorySource: (unit, when) => `প্রস্তাব করেছে ${unit}, ${when}`,
  memoryConfirmedBy: (who, when) => `নিশ্চিত করেছেন ${who}, ${when}`,
  remember: 'মনে রাখুন',
  dontRemember: 'মনে রাখবেন না',
  forget: 'ভুলে যান',
  forgetAsk: (text) => `"${text}" ভুলে যাবেন?`,
  memoryDecided: { confirmed: 'মনে রাখা হয়েছে।', rejected: 'মনে রাখা হয়নি।', forgotten: 'ভুলে যাওয়া হয়েছে।' },

  connectedApps: 'সংযুক্ত অ্যাপ',
  apps: 'অ্যাপ',
  keys: 'কী',
  noApps: 'কোনো অ্যাপ সংযুক্ত নেই।',
  noKeys: 'আপনার কোনো কী নেই।',
  clientStatus: { known: 'পরিচিত অ্যাপ', verified: 'যাচাই করা', unverified: 'যাচাই করা নয়' },
  keyKind: { personal: 'ব্যক্তিগত কী', service: 'সার্ভিস কী' },
  connectedOn: (when) => `সংযুক্ত হয়েছে ${when}`,
  lastUsed: (when) => `শেষ ব্যবহার ${when}`,
  neverUsed: 'এখনো ব্যবহার হয়নি',
  expiresOn: (when) => `মেয়াদ শেষ ${when}`,
  revoke: 'বাতিল করুন',
  revokeAsk: (name) => `${name} বাতিল করবেন? সঙ্গে সঙ্গে কাজ বন্ধ হবে।`,
  revoked: (name) => `${name} বাতিল করা হয়েছে।`,

  grantsTitle: 'স্থায়ী অনুমতি',
  grantsHelp: 'নির্দিষ্ট দিন ও দিনে নির্দিষ্ট বারের জন্য কোপাইলটকে একটি ধরনের পরিবর্তন প্রতিবার না জিজ্ঞেস করে করতে দিন। অনুমোদন কখনো বাদ যায় না।',
  noGrants: 'প্রতিটি পরিবর্তনের আগে কোপাইলট আপনাকে জিজ্ঞেস করে।',
  capability: 'পরিবর্তন',
  days: 'দিন',
  dailyCap: 'দিনে কতবার',
  addGrant: 'অনুমতি দিন',
  grantLeft: (left, cap) => `আজ ${cap}বারের মধ্যে ${left}বার বাকি`,
  grantSaved: (name) => `${name} অনুমতি পেয়েছে।`,
}

export const UI_TEXT: Readonly<Record<UiLocale, UiText>> = Object.freeze({ en, bn })

/** Overrides a product may pass: any key, and for the records any of their keys. */
export type UiTextOverrides = { [K in keyof UiText]?: UiText[K] extends Record<string, string> ? Partial<UiText[K]> : UiText[K] }

/** The text for a locale with the product's overrides on top. An unknown locale is English. */
export function uiText(locale: string = 'en', overrides: UiTextOverrides = {}): UiText {
  const base = locale === 'bn' || locale.startsWith('bn-') ? bn : en
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] = cur && typeof cur === 'object' && v && typeof v === 'object' ? { ...cur, ...v } : v
  }
  return out as unknown as UiText
}

/**
 * The tag `Intl` gets. Bangla always uses Bengali digits: a `bn` tag without a
 * numbering system gets `-u-nu-beng`, because some runtimes (Bun, some Node
 * builds) default `bn-BD` to Latin digits.
 */
export function intlLocale(locale: string): string {
  if (!/^bn(-|$)/i.test(locale) || /-u-(?:[a-z0-9]{2,8}-)*nu-/i.test(locale) || /-x-/i.test(locale)) return locale
  return /-u-/i.test(locale) ? `${locale}-nu-beng` : `${locale}-u-nu-beng`
}

/** A number in the text's locale (Bengali digits for Bangla). */
export function formatNumber(text: Pick<UiText, 'locale'>, n: number): string {
  try {
    return new Intl.NumberFormat(intlLocale(text.locale)).format(n)
  } catch {
    return String(n)
  }
}

/** A date and time in the text's locale (Bengali digits for Bangla). Accepts ISO text or epoch ms; null gives `text.none`. */
export function formatDate(text: Pick<UiText, 'locale' | 'none'>, at: string | number | null | undefined, opts: { time?: boolean } = {}): string {
  if (at === null || at === undefined || at === '') return text.none
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return String(at)
  try {
    return new Intl.DateTimeFormat(intlLocale(text.locale), opts.time === false ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }).format(d)
  } catch {
    return d.toISOString()
  }
}
