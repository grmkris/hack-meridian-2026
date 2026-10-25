-- MCP Events (draft SEP-3415, `io.modelcontextprotocol/events`): what happened to a wallet, and who asked to hear it.
-- event_journal: one row per event, written in the same D1 batch as the state change it reports (ledger.ts, store.ts)
-- or by the wallet's Durable Object watcher (payments received onchain). `seq` is the cursor every reader resumes from;
-- `event_id` is deterministic, so a second writer of the same fact (the watcher and a Nod→Nod settle) is a no-op.
-- `data` is the event's JSON payload, written by Nod only (never a third party's free text); a `url` starting with `/`
-- is resolved against the reader's origin.
CREATE TABLE event_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  wallet_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX event_journal_by_wallet ON event_journal (wallet_id, seq);

-- One webhook subscription of one connection (the OAuth principal) to one event with its arguments and callback URL.
-- `id` is 'sub_' + sha256 of the principal, URL, name and canonical arguments, so a refresh keeps it. One cursor per
-- subscription: the seq of the last journal row it has passed (delivered, or not matching its arguments). Times are
-- epoch milliseconds. `revision` fences writers: a refresh bumps it, and a delivery advances the cursor only for the
-- revision it read. `terminating` = revoked, the `terminated` control is still to be sent.
CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments TEXT NOT NULL,
  url TEXT NOT NULL,
  -- The public origin the subscriber used; relative links in payloads resolve against it.
  origin TEXT NOT NULL,
  sealed_secret TEXT NOT NULL,
  previous_secret TEXT,
  previous_until INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'terminating', 'terminated')),
  cursor INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  failed_since INTEGER,
  last_error TEXT,
  verified_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (connection_id, name, arguments, url)
);
CREATE INDEX event_subscriptions_by_wallet ON event_subscriptions (wallet_id, state);
CREATE INDEX event_subscriptions_by_connection ON event_subscriptions (connection_id, state);

-- Small counters of the events machinery: `pruned_through` = the highest journal seq removed by retention, so a
-- reader whose cursor is older learns its replay was truncated.
CREATE TABLE event_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
