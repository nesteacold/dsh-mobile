// History store (US3 / contract §4 `history`): ordered messages for one session plus the
// deduplication rules that keep "no duplicate and no lost messages" (SC-005) true across
// reconnects and outbox retries.
//
// Pure: no react-native/expo/Node imports; the clock is injected.

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'other';

export interface HistoryMessage {
  /** Monotonic sequence from the host, or null when the row carried none. */
  seq: number | null;
  /** Stable id (host message id, or the clientMsgId for our own optimistic rows). */
  id: string;
  role: MessageRole;
  text: string;
  /** Our own prompt not yet confirmed by the host. */
  pending?: boolean;
  /** Set when the Host refused this prompt: the wire code, so the bubble never silently "sends". */
  failed?: string;
  /** Epoch ms (host `createdAt`/`timestamp`, or the send time for pending rows). */
  at: number | null;
  /**
   * The agent's own reasoning for this answer, when the Host sent one (spec 017 wave 1,
   * ProcessReasoningDisclosure). Rendered collapsed behind a disclosure, never inline: it is the
   * model's thinking, not part of the reply. Absent for user/tool rows and for answers without it.
   */
  reasoning?: string;
}

export interface HistoryPage {
  items: HistoryMessage[];
  /** True when the host has more (older) pages; the UI offers "load earlier". */
  hasMore: boolean;
  /** Cursor for the next `history` request (`beforeSeq`). */
  nextBeforeSeq: number | null;
  /**
   * The `historyFormatVersion` the Host requires alongside every cursor
   * (`PROTOCOL.md:748`). Taken from the first `history` reply and sent back verbatim: the gateway
   * refuses a cursor without it (`history-format-mismatch`, `resetRequired: true`).
   */
  formatVersion: number | null;
}

const ROLES: readonly MessageRole[] = ['user', 'assistant', 'tool', 'system'];

function coerceRole(value: unknown): MessageRole {
  if (typeof value !== 'string') return 'other';
  const lower = value.toLowerCase();
  return (ROLES as readonly string[]).includes(lower) ? (lower as MessageRole) : 'other';
}

function coerceText(row: Record<string, unknown>): string {
  if (typeof row.text === 'string') return row.text;
  if (typeof row.content === 'string') return row.content;
  if (Array.isArray(row.content)) {
    // Host content parts: `[{ type: 'text', text }, …]`.
    return row.content
      .map((part) => (typeof part === 'string' ? part : typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .filter((text) => text !== '')
      .join('\n');
  }
  if (typeof row.message === 'string') return row.message;
  return '';
}

function coerceAt(row: Record<string, unknown>): number | null {
  for (const key of ['createdAt', 'timestamp', 'at'] as const) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

export function coerceHistoryMessage(raw: unknown, fallbackIndex: number): HistoryMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const seq = typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : null;
  const id =
    typeof row.id === 'string' && row.id.length > 0
      ? row.id
      : typeof row.messageId === 'string' && row.messageId.length > 0
        ? row.messageId
        : seq !== null
          ? `seq-${seq}`
          : `index-${fallbackIndex}`;
  const text = coerceText(row);
  // A row with neither text nor role is not a message (empty objects, metadata rows).
  const hasRole = typeof row.role === 'string';
  if (text === '' && !hasRole) return null;
  return { seq, id, role: coerceRole(row.role), text, at: coerceAt(row) };
}

// ── DSH session events → history rows ─────────────────────────────────────────────────────────────
//
// WHY this exists (measured 2026-11-11): the gateway does not send the `{role, text}` rows the
// contract describes (`specs/001-…/mobile-protocol-v1.md:213`); it forwards DSH events instead, in
// two shapes, and neither carries `role` for prose:
//   * live:    `{kind:'event', sessionId, seq, time, event:{type, text, …}}` — `buildWireEvent()`
//              (`plugins/mobile-gateway/lib/index.mjs:416-460`) flattens user/assistant text to
//              `event.text` and never sets `event.role`;
//   * history: raw `{type, seq, time, data:{message:{content}, …}}` (`PROTOCOL.md:744`, reply at
//              `PROTOCOL.md:768`), with `data.stream` stripped in `view:'conversation'`.
// `coerceHistoryMessage` therefore saw role `undefined` → `'other'`, and every row — user prompts and
// agent prose alike — rendered as the "HOẠT ĐỘNG" tool pill on device.
//
// The mapping below is driven only by fields those two measured shapes actually carry, and it skips
// protocol chatter outright (a `turn/start` is not a message, and inventing a `system` row for it
// would put engine noise in the transcript). A row that already carries `role` keeps the old path
// byte-for-byte, so the contract shape stays supported.

/** Wire event types whose text the transcript shows, and the role each becomes. */
const EVENT_ROLE: Readonly<Record<string, MessageRole>> = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/call': 'tool',
  'tool/result': 'tool',
};

/**
 * Event types deliberately NOT rendered as messages: turn/run bookkeeping, token streams, request
 * metadata, titles, presets, deliverables lists and compaction/command notices belong to chrome the
 * conversation screen does not draw (and a `deliverables/presented` row would duplicate the file
 * chips the tool rows already summarise).
 */
export const SKIPPED_HISTORY_EVENT_TYPES: readonly string[] = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'request/header',
  'request/context',
  'system/message',
  // DSH renders `developer/message` as context, not as a user turn; on a phone it is not a bubble.
  'developer/message',
  'assistant/chunk',
  'assistant/attempt',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'session/title',
  'agent-preset/selected',
  'deliverables/presented',
  'command/run',
  'command/done',
  'compaction/start',
  'compaction/done',
  'compaction/summary',
  'compaction/end',
  'job/registered',
  'job/settled',
  'workspace/changes',
  'agent/inbox/spliced',
  'tool/ptc-dispatch',
  'tool/code-dispatch',
];

const SKIPPED = new Set(SKIPPED_HISTORY_EVENT_TYPES);

/** Text of a DSH content-block array (`[{type:'text',text}]`, images ignored). */
function contentText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    const entry = block as Record<string, unknown>;
    if (entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text);
  }
  return parts.join('\n');
}

/**
 * The `reasoning` blocks of a content array (MEASURED shape: `{type:'reasoning', text}` — the live
 * wire flattens them into `event.reasoning`, the history page keeps them inside
 * `data.message.content`, both per packaging's capture).
 */
function contentReasoning(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    const entry = block as Record<string, unknown>;
    if (entry.type === 'reasoning' && typeof entry.text === 'string') parts.push(entry.text);
  }
  return parts.join('\n');
}

/** First line of a tool's raw arguments, for the collapsed pill. */
function argumentSummary(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  }
  return '';
}

/**
 * Turn one DSH event (live or history shape) into a history row, or null when it is not conversation.
 *
 * Accepts, in this order: the contract's `{role, text}` row (unchanged behaviour), the live
 * `{type, …flattened}` event, and the history `{type, seq, time, data}` session event.
 */
/**
 * Markers DSH puts in the transcript as `user/message` even though the user never typed them.
 *
 * A phone conversation must show what the person said; the runtime-context block, the skill catalog,
 * the "Time sampled…" clock line and `<system-reminder>` fences are Host bookkeeping. MEASURED on
 * `session-391f5de4-f4ec-41e6-b22f-24b25455ba1a`: of the 20 events, seq 10, 11 and 12 are such
 * `user/message` events around the ONE real prompt at seq 9, so rendering them verbatim produced a
 * transcript with three fake user turns before the answer.
 *
 * Matching is a case-insensitive substring test. A user who deliberately pastes one of these strings
 * into the composer would be filtered too; that is accepted, because every marker is Host-generated
 * boilerplate that a person does not type, and the alternative (heuristics on length or position)
 * would silently drop real prompts.
 */
const HOST_INJECTED_MARKERS: readonly string[] = [
  '<system-reminder>',
  'runtime-context',
  'current dsh file policy',
  '<available_skills>',
  'the available skill catalog changed',
  'skill catalog',
  'time sampled while preparing',
  'browser time zone for this request',
  'instructions from:',
];

/** True when a `user/message` body is Host bookkeeping rather than something the user wrote. */
export function isHostInjectedUserText(text: string): boolean {
  if (text === '') return false;
  const flat = text.toLowerCase();
  return HOST_INJECTED_MARKERS.some((marker) => flat.includes(marker));
}

export function coerceHistoryEvent(raw: unknown, fallbackIndex = 0): HistoryMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const event = raw as Record<string, unknown>;
  // The contract shape (and everything the store already understands) wins: no behaviour change.
  // NOTE: the source row is spread first so additive fields a later host adds (e.g. the
  // `session.workspaceId` the list screen will read) survive this normalisation instead of being
  // dropped by a wholesale rebuild.
  if (typeof event.role === 'string') {
    const row = coerceHistoryMessage(event, fallbackIndex);
    if (row === null) return null;
    if (row.role === 'user' && isHostInjectedUserText(row.text)) return null;
    return { ...event, ...row } as HistoryMessage;
  }

  const type = typeof event.type === 'string' ? event.type : null;
  if (type === null || SKIPPED.has(type)) return null;
  const role = EVENT_ROLE[type];
  if (role === undefined) return null;

  const data = typeof event.data === 'object' && event.data !== null
    ? (event.data as Record<string, unknown>)
    : {};
  const message = typeof data.message === 'object' && data.message !== null
    ? (data.message as Record<string, unknown>)
    : {};

  let text = '';
  let reasoning = '';
  if (type === 'user/message') {
    // MEASURED (session-391f5de4, seq 9): a user turn keeps its text in `data.message.content[]`,
    // exactly like the assistant turn — reading only `data.content` produced an empty body and the
    // real prompt silently vanished. The flattened `event.text` still wins when the live wire sends it.
    text = typeof event.text === 'string'
      ? event.text
      : contentText(message.content) || contentText(data.content) || contentText(event.content);
    // DSH writes its own bookkeeping into the transcript as `user/message` events: the
    // runtime-context block, the skill catalog, the "Time sampled…" line and <system-reminder>
    // fences. They are not the user speaking, so they never become a bubble (MEASURED on
    // session-391f5de4: seq 10-12 of 20 are exactly these three, around ONE real prompt at seq 9).
    if (isHostInjectedUserText(text)) return null;
  } else if (type === 'assistant/message') {
    text = typeof event.text === 'string'
      ? event.text
      : contentText(message.content) || contentText(data.content) || contentText(event.content);
    // Live wire: `event.reasoning` (buildWireEvent flattens the blocks). History: the blocks are
    // still inside `data.message.content`.
    reasoning = typeof event.reasoning === 'string' && event.reasoning !== ''
      ? event.reasoning
      : contentReasoning(message.content) || contentReasoning(data.content);
  } else if (type === 'tool/call') {
    const name = typeof event.name === 'string' ? event.name : (typeof data.name === 'string' ? data.name : '');
    const summary = argumentSummary(event.arguments ?? data.arguments);
    text = summary === '' ? name : `${name} ${summary}`.trim();
  } else if (type === 'tool/result') {
    // MEASURED (packaging, live gateway): the text is in `data.message.content[]` AND flattened into
    // `data.output`; the error flag is `data.message.isError` (the live wire also sends `isError` and
    // a `preview`). `preview` wins on the live shape because it is the bounded one.
    text = typeof event.preview === 'string'
      ? event.preview
      : (typeof data.preview === 'string'
        ? data.preview
        : contentText(message.content) || (typeof data.output === 'string' ? data.output : '') || contentText(data.content));
    if (text === '' && (event.isError === true || message.isError === true || data.isError === true)) text = 'error';
  }
  if (text === '') return null;

  const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null;
  const row: Record<string, unknown> = { seq, role, text };
  if (reasoning !== '') row.reasoning = reasoning;
  // The live frame keeps `event.seq` on the *frame*; callers pass the flattened event, so the seq
  // arrives there. `at` is `time` (live) or `createdAt` (rows); both are epoch ms.
  const at = typeof event.time === 'number' ? event.time : undefined;
  if (at !== undefined) row.createdAt = at;
  const mapped = coerceHistoryMessage(row, fallbackIndex);
  // `coerceHistoryMessage` normalises to the known keys, so the reasoning is re-attached here.
  if (mapped === null) return null;
  return reasoning === '' ? mapped : { ...mapped, reasoning };
}

/** Map a page of wire events to rows, dropping everything that is not conversation. */
export function coerceHistoryEvents(raw: unknown): HistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryMessage[] = [];
  raw.forEach((entry, index) => {
    const row = coerceHistoryEvent(entry, index);
    if (row !== null) out.push(row);
  });
  return out;
}

/** Sort key: `seq` when present, else arrival order. */function compare(a: HistoryMessage, b: HistoryMessage, indexA: number, indexB: number): number {
  if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
  return indexA - indexB;
}

export class HistoryStore {
  private messages: HistoryMessage[] = [];
  private readonly now: () => number;
  private hasMoreFlag = false;
  private nextBeforeSeqValue: number | null = null;
  private formatVersionValue: number | null = null;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get items(): HistoryMessage[] {
    return [...this.messages];
  }

  get page(): HistoryPage {
    return {
      items: this.items,
      hasMore: this.hasMoreFlag,
      nextBeforeSeq: this.nextBeforeSeqValue,
      formatVersion: this.formatVersionValue,
    };
  }

  /** Replace with the first page from a `history` response. */
  setPage(
    rawItems: unknown,
    meta: { hasMore?: boolean; nextBeforeSeq?: number | null; formatVersion?: number | null } = {},
  ): void {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const coerced: HistoryMessage[] = [];
    items.forEach((raw, index) => {
      const message = coerceHistoryMessage(raw, index);
      if (message !== null) coerced.push(message);
    });
    this.messages = this.dedupe(coerced);
    this.hasMoreFlag = meta.hasMore ?? false;
    // Older pages are requested with the lowest seq currently loaded.
    this.nextBeforeSeqValue = meta.nextBeforeSeq ?? this.firstSeq();
    if (typeof meta.formatVersion === 'number') this.formatVersionValue = meta.formatVersion;
  }

  /**
   * Prepend an older page (`beforeSeq`). Overlapping rows (same id or seq) are dropped, all
   * history arrays already loaded stay in place => loading earlier never duplicates.
   */
  prependPage(
    rawItems: unknown,
    meta: { hasMore?: boolean; nextBeforeSeq?: number | null } = {},
  ): void {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const older: HistoryMessage[] = [];
    items.forEach((raw, index) => {
      const message = coerceHistoryMessage(raw, index);
      if (message !== null) older.push(message);
    });
    this.messages = this.dedupe([...older, ...this.messages]);
    this.hasMoreFlag = meta.hasMore ?? false;
    // The Host's own cursor wins: the gateway hands out `nextBeforeSeq` for the page it just served,
    // and re-deriving it from the loaded rows loses the case where a page is entirely filtered out
    // (system messages, tool rows), which then looked like "no older history".
    this.nextBeforeSeqValue = meta.nextBeforeSeq ?? this.firstSeq();
  }

  /** Does the loaded transcript contain a real (non-injected) prompt? */
  hasUserTurn(): boolean {
    return this.messages.some((message) => message.role === 'user');
  }

  /** Append live messages from `event` pushes or from a local `sent` receipt. */
  append(raw: unknown): HistoryMessage | null {
    const message = coerceHistoryMessage(raw, this.messages.length);
    if (message === null) return null;
    // Idempotent by id (and by seq when both sides have one): a replayed event never forks.
    if (this.messages.some((m) => m.id === message.id || (m.seq !== null && m.seq === message.seq))) return null;
    this.messages.push(message);
    return message;
  }

  /**
   * Our own prompt before the host echoed it. Rendered immediately; replaced when the host
   * reports the same `clientMsgId`.
   */
  /**
   * Confirm EVERY still-pending prompt of the open session.
   *
   * Safety net: a streamed event for this session proves the turn reached the Host, so no prompt of it
   * may keep claiming "sending" even if its receipt was lost in a drop. Returns how many changed.
   */
  confirmAllPending(): number {
    let changed = 0;
    for (const message of this.messages) {
      if (message.pending === true) {
        message.pending = false;
        changed += 1;
      }
    }
    return changed;
  }

  /** The Host refused this prompt: stop claiming it is sending, and keep the reason for the UI. */
  markPromptFailed(clientMsgId: string, code: string): void {
    const prompt = this.messages.find((message) => message.id === clientMsgId);
    if (prompt === undefined) return;
    prompt.pending = false;
    prompt.failed = code;
  }

  addPendingPrompt(clientMsgId: string, text: string): HistoryMessage {
    const existing = this.messages.find((m) => m.id === clientMsgId);
    if (existing) return existing;
    const message: HistoryMessage = {
      seq: null,
      id: clientMsgId,
      role: 'user',
      text,
      pending: true,
      at: this.now(),
    };
    this.messages.push(message);
    return message;
  }

  /** The host echoed a message that carries our `clientMsgId`: replace the optimistic row. */
  confirmPending(clientMsgId: string, raw: unknown): HistoryMessage | null {
    const pending = this.messages.find((m) => m.id === clientMsgId);
    if (pending === undefined) return this.append(raw);
    const confirmed = coerceHistoryMessage(raw, this.messages.length);
    if (confirmed === null) {
      pending.pending = false;
      return pending;
    }
    const index = this.messages.indexOf(pending);
    this.messages[index] = { ...confirmed, id: confirmed.id, pending: false };
    return this.messages[index] as HistoryMessage;
  }

  /** The replacement for a first page that lost our own row (e.g. the prompt was rejected). */
  remove(clientMsgId: string): void {
    this.messages = this.messages.filter((m) => m.id !== clientMsgId);
  }

  clear(): void {
    this.messages = [];
    this.hasMoreFlag = false;
    this.nextBeforeSeqValue = null;
  }

  private lastSeq(): number | null {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const seq = this.messages[index]?.seq;
      if (typeof seq === 'number') return seq;
    }
    return null;
  }

  private firstSeq(): number | null {
    for (const message of this.messages) {
      if (typeof message.seq === 'number') return message.seq;
    }
    return null;
  }

  private dedupe(items: HistoryMessage[]): HistoryMessage[] {
    const seenIds = new Set<string>();
    const seenSeqs = new Set<number>();
    const indexed = items.map((item, index) => ({ item, index }));
    indexed.sort((a, b) => compare(a.item, b.item, a.index, b.index));
    const out: HistoryMessage[] = [];
    for (const { item } of indexed) {
      if (seenIds.has(item.id)) continue;
      if (item.seq !== null && seenSeqs.has(item.seq)) continue;
      seenIds.add(item.id);
      if (item.seq !== null) seenSeqs.add(item.seq);
      out.push(item);
    }
    return out;
  }
}
