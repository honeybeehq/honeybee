CREATE TABLE account_admission_reservations (
  id                         TEXT PRIMARY KEY,
  request_key                TEXT NOT NULL UNIQUE,
  scope                      TEXT NOT NULL,
  account                    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_account             TEXT,
  operation                  TEXT NOT NULL CHECK (operation IN ('spawn','swap','fork','handoff')),
  units                      REAL NOT NULL CHECK (units > 0),
  bee_id                     TEXT,
  reconcile_after_generation INTEGER NOT NULL CHECK (reconcile_after_generation >= 0),
  receipt                    TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  expires_at                 INTEGER NOT NULL,
  confirmed_at               INTEGER,
  released_at                INTEGER,
  CHECK (expires_at > created_at)
) STRICT;
CREATE TABLE account_credential_authorities (
  account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('enrolling','ready','refreshing','uncertain','login_required','disabling','disabling_uncertain','disabled','handing_off','adopting')),
  generation INTEGER NOT NULL,
  expires_at INTEGER,
  operation_key TEXT,
  updated_at INTEGER NOT NULL,
  refresh_token_expires_at INTEGER,
  failure TEXT,
  authority_instance_id TEXT
) STRICT;
CREATE TABLE account_limit_observations (
  account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE account_limits (
  account              TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  fetched_at           INTEGER NOT NULL,
  readable             INTEGER NOT NULL CHECK (readable IN (0,1)),
  unreadable_reason    TEXT CHECK (unreadable_reason IS NULL OR unreadable_reason IN ('unsupported','auth_expired','auth_failed','provider_error','timeout','refresh_deferred')),
  error                TEXT,
  plan                 TEXT,
  five_hour_pct        REAL,
  five_hour_resets_at  INTEGER,
  five_hour_minutes    INTEGER,
  weekly_pct           REAL,
  weekly_resets_at     INTEGER,
  weekly_minutes       INTEGER,
  fable_weekly_pct     REAL,
  fable_resets_at      INTEGER,
  fable_minutes        INTEGER,
  display_windows      TEXT NOT NULL DEFAULT '[]',
  rate_limit_reset_credits TEXT
) STRICT;
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','leased')),
  leased_from   TEXT,
  harness       TEXT NOT NULL,
  home_path     TEXT NOT NULL,
  label         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','auth_needed','paused')),
  status_reason TEXT,
  refresh_token_expires_at INTEGER,
  penalty       INTEGER NOT NULL DEFAULT 0,
  weekly_ceiling INTEGER CHECK (weekly_ceiling IS NULL OR (weekly_ceiling BETWEEN 1 AND 100)),
  last_login_at INTEGER,
  exhausted_at  INTEGER,
  paused_by     TEXT CHECK (paused_by IS NULL OR paused_by IN ('operator','quota','lease')),
  paused_owner  TEXT,
  paused_at     INTEGER,
  native        INTEGER NOT NULL DEFAULT 0 CHECK (native IN (0,1)),
  added_at      INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE TABLE action_enqueues (
  idempotency_key TEXT PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  bee_id          TEXT NOT NULL,
  action_ids_json TEXT NOT NULL,
  created_at      INTEGER NOT NULL
) STRICT;
CREATE TABLE action_queues (
  bee_id        TEXT PRIMARY KEY REFERENCES bees(id) ON DELETE CASCADE,
  paused        INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  paused_at     INTEGER,
  next_position INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE TABLE actions (
  id                   TEXT PRIMARY KEY,
  bee_id               TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL,
  client_ref           TEXT,
  kind                 TEXT NOT NULL,
  definition_version   INTEGER NOT NULL,
  executor             TEXT NOT NULL CHECK (executor IN ('agent','cell.capture','lifecycle.archive','external')),
  title                TEXT NOT NULL,
  definition_json      TEXT NOT NULL,
  inputs_json          TEXT NOT NULL,
  resolved_inputs_json TEXT,
  status               TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
  waiting_reason       TEXT CHECK (waiting_reason IN ('input','executor','uncertain')),
  waiting_detail       TEXT,
  attempt              INTEGER NOT NULL DEFAULT 0,
  attempt_token        TEXT,
  dispatch_json        TEXT,
  dispatch_message_id  INTEGER,
  operation_key        TEXT,
  progress_json        TEXT,
  question_id          TEXT,
  result_json          TEXT,
  failure_json         TEXT,
  attempts_json        TEXT NOT NULL DEFAULT '[]',
  enqueue_key          TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  finished_at          INTEGER,
  UNIQUE (bee_id, position)
) STRICT;
CREATE TABLE audit (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  bee_id  TEXT,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE auth_interruptions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  bee_id                   TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  account                  TEXT NOT NULL,
  generation               INTEGER NOT NULL CHECK (generation >= 1),
  message_ids              TEXT NOT NULL DEFAULT '[]',
  turn_progress            TEXT NOT NULL CHECK (turn_progress IN ('none','some','unknown')),
  credential_revision      TEXT NOT NULL,
  detail                   TEXT NOT NULL,
  interrupted_at           INTEGER NOT NULL,
  state                    TEXT NOT NULL CHECK (state IN ('open','restored','resumed','completed','cancelled','superseded')),
  blocked_revision         TEXT,
  restored_revision        TEXT,
  restored_by              TEXT CHECK (restored_by IN ('login','capture','refresh','limits_probe','credentials_restored','account_swap')),
  restored_at              INTEGER,
  continuation_kind        TEXT CHECK (continuation_kind IN ('redeliver','continue','revive')),
  continuation_message_ids TEXT NOT NULL DEFAULT '[]',
  settled_at               INTEGER,
  settle_reason            TEXT CHECK (settle_reason IN ('stopped_by_user','archived','turn_succeeded','auth_failed_again','auth_recovery_expired','auth_recovery_cancelled')),
  death_recovery TEXT
) STRICT;
CREATE TABLE bee_handle_reservations (
  handle TEXT PRIMARY KEY COLLATE NOCASE
) STRICT;
CREATE TABLE bee_handoffs (
  id                         TEXT PRIMARY KEY,
  bee_id                     TEXT NOT NULL,
  idempotency_key            TEXT NOT NULL UNIQUE,
  request_hash               TEXT NOT NULL,
  phase                      TEXT NOT NULL CHECK (phase IN ('stopping','summarizing','starting','complete','failed')),
  source_generation          INTEGER NOT NULL,
  target_generation          INTEGER,
  from_agent                 TEXT NOT NULL,
  from_args                  TEXT,
  from_account               TEXT,
  from_provider_session_id   TEXT,
  from_segment_id            TEXT NOT NULL,
  to_agent                   TEXT NOT NULL,
  to_args                    TEXT,
  to_account                 TEXT,
  to_segment_id              TEXT,
  to_env                     TEXT NOT NULL DEFAULT '{}',
  to_session_log_path        TEXT,
  instruction                TEXT,
  stop_at                    TEXT NOT NULL CHECK (stop_at IN ('idle','now')),
  source_was_live            INTEGER NOT NULL DEFAULT 0 CHECK (source_was_live IN (0,1)),
  stop_command_key           TEXT NOT NULL,
  revive_command_key         TEXT NOT NULL,
  seed_message_id            INTEGER,
  context_json               TEXT,
  failure_json               TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
) STRICT;
CREATE TABLE bee_moves (
  id                    TEXT PRIMARY KEY,
  bee_id                TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  request_hash          TEXT NOT NULL,
  phase                 TEXT NOT NULL CHECK (phase IN ('stopping','placing','starting','complete','failed')),
  source_generation     INTEGER NOT NULL,
  from_cwd              TEXT NOT NULL,
  from_substrate        TEXT NOT NULL,
  to_cwd                TEXT NOT NULL,
  to_substrate          TEXT NOT NULL DEFAULT 'hsr',
  retained_cell_id      TEXT NOT NULL,
  stop_command_key      TEXT NOT NULL,
  revive_command_key    TEXT NOT NULL,
  placement_version     INTEGER NOT NULL,
  instructions_pending  INTEGER NOT NULL DEFAULT 1,
  instructions_applied  INTEGER NOT NULL DEFAULT 0,
  failure_json          TEXT,
  observed_head         TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
) STRICT;
CREATE TABLE bee_reference_claims (
  bee_id TEXT PRIMARY KEY,
  handle TEXT COLLATE NOCASE,
  human_ref TEXT UNIQUE COLLATE NOCASE,
  issuing_namespace TEXT
) STRICT;
CREATE TABLE bees (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  agent            TEXT NOT NULL,
  substrate        TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  title            TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',
  session_log_path TEXT,
  lifecycle        TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
  created_at       INTEGER NOT NULL,
  archived_at      INTEGER,
  last_output_at   INTEGER,
  -- v3: harness-native session/thread id of the bee's conversation (claude
  -- session_id, codex thread id). Recorded from the runtime's booted signal;
  -- revive hands it back to the harness (claude --resume / codex thread/resume)
  -- so a new generation continues the same conversation (spec 07 §F).
  provider_session_id TEXT,
  -- v3: per-bee env overrides applied over the agent spec at spawn (json
  -- object of strings). The importer uses it for the harness config home
  -- (CLAUDE_CONFIG_DIR / CODEX_HOME / …) an old-world session lives in.
  env              TEXT NOT NULL DEFAULT '{}',
  -- v3: provenance — null for bees born in v2, "frozen" for records imported
  -- from the frozen old-world store (id preserved; details in the audit row).
  imported_from    TEXT,
  -- v4: consecutive boot failures — runtimes that exited (crashed/clean)
  -- while still booting. Reset to 0 by a successful boot (booting →
  -- running) or an operator revive. The wake path applies the B5 backoff
  -- table to it and stops reviving at the budget (spawn_failed flag).
  spawn_failures   INTEGER NOT NULL DEFAULT 0,
  -- v5: per-bee harness CLI args (json array of strings, or NULL = none),
  -- composed over the agent spec's args at spawn (daemon resolveSpawnSpec:
  -- spec args < spec defaultArgs < bee args < resume args; later wins per flag).
  args             TEXT,
  -- v6: the bee that spawned this one (soft reference — no FK, so a parent
  -- may be deleted; delete ORPHANS local children by nulling this, never
  -- cascades).
  parent_id        TEXT,
  -- v21: true when parent_id names a parent owned outside this node. This is
  -- durable provenance, never a local foreign key or a delete-cascade edge.
  parent_external  INTEGER NOT NULL DEFAULT 0 CHECK (parent_external IN (0,1)),
  -- v6: provenance — the bee this one was forked from (soft reference).
  forked_from      TEXT,
  -- v6: one-shot fork seed — the SOURCE's provider session id the first
  -- runtime forks from (claude --resume <seed> --fork-session, codex
  -- thread/fork); cleared once the fork's own session id is recorded.
  fork_seed        TEXT,
  -- v7: the account (accounts.id) this bee runs on — declared intent made
  -- concrete at spawn ('auto' is resolved BEFORE the row is written; never
  -- stored). Soft reference: account.remove refuses while any bee carries
  -- it. The mechanism stays bees.env[HOME_ENV[harness]] = accounts.home_path.
  account          TEXT,
  -- v10: short human display id (CL.a3f2 — harness prefix + hex), minted by
  -- the issuing node at spawn; retained as a legacy alias. The
  -- UUID above stays the canonical id everywhere machines talk.
  handle           TEXT,
  human_ref        TEXT,
  issuing_namespace TEXT,
  -- v22: Cell→checkout placement generation (CAS for bee.move).
  placement_version INTEGER NOT NULL DEFAULT 0,
  -- v22: in-flight bee_moves.id; NULL when idle (complete/failed receipts remain).
  active_move_id   TEXT,
  -- v22: cells.id for the active or retained Cell.
  cell_id          TEXT,
  -- v23: in-flight bee_handoffs.id; NULL when idle (terminal receipts remain).
  active_handoff_id TEXT,
  last_turn_trigger TEXT,
  last_human_output_at INTEGER
, auth_control_fence INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE cell_ops (
  id              TEXT PRIMARY KEY,
  cell_id         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('exec','remove')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','outcome_unknown')),
  argv_json       TEXT,
  cwd             TEXT,
  timeout_ms      INTEGER,
  pid             INTEGER,
  pid_started_at  INTEGER,
  exit_code       INTEGER,
  stdout          TEXT NOT NULL DEFAULT '',
  stderr          TEXT NOT NULL DEFAULT '',
  truncated       INTEGER NOT NULL DEFAULT 0,
  failure         TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;
CREATE TABLE cells (
  id              TEXT PRIMARY KEY,
  source_bee_id   TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('active','retained','evicted','removing','removed')),
  git_common_dir  TEXT NOT NULL,
  object_format   TEXT NOT NULL CHECK (object_format IN ('sha1','sha256')),
  origin_repo     TEXT NOT NULL,
  sha             TEXT NOT NULL,
  wrapper         TEXT NOT NULL,
  space_name      TEXT NOT NULL,
  space_dir       TEXT NOT NULL,
  sandbox         INTEGER,
  created_at      INTEGER NOT NULL,
  retained_at     INTEGER,
  removed_at      INTEGER,
  evicted_at      INTEGER,
  evicted_head    TEXT
) STRICT;
CREATE TABLE commands (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  verb              TEXT NOT NULL CHECK (verb IN ('spawn','send_wake','stop','revive','archive','unarchive','delete','reconnect_tools')),
  bee_id            TEXT NOT NULL,
  args              TEXT NOT NULL DEFAULT '{}',
  target_generation INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL,
  enqueued_at       INTEGER NOT NULL,
  finished_at       INTEGER,
  failure_cause     TEXT CHECK (failure_cause IN ('auth_needed','resource_blocked','spawn_failed','node_unreachable')),
  idempotency_key   TEXT
) STRICT;
CREATE TABLE credential_authority_epochs (
  account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  demoted INTEGER NOT NULL DEFAULT 0 CHECK (demoted IN (0,1))
) STRICT;
CREATE TABLE credential_handoff_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('exported','preparing','prepared','committed','adopting','adopted','failed','aborted','confirmed','stood_down')),
  at INTEGER NOT NULL
) STRICT;
CREATE TABLE credential_handoffs (
  handoff_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source','destination')),
  account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('exported','preparing','prepared','committed','adopting','adopted','failed','aborted','confirmed','stood_down')),
  record TEXT NOT NULL,
  PRIMARY KEY (handoff_id, role)
) STRICT;
CREATE TABLE flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bee_id     TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  flag       TEXT NOT NULL CHECK (flag IN ('auth_needed','resource_blocked','spawn_failed','node_unreachable')),
  detail     TEXT NOT NULL,
  set_at     INTEGER NOT NULL,
  cleared_at INTEGER,
  -- v17: the provider-declared instant (epoch ms) the block lifts, e.g. a
  -- rate-limit resetsAt. NULL = open-ended; only contrary evidence clears it.
  resets_at  INTEGER
) STRICT;
CREATE TABLE human_ref_allocations (
  installation_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL UNIQUE,
  receipt TEXT NOT NULL
) STRICT;
CREATE TABLE human_ref_issuer (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  namespace TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  receipt TEXT NOT NULL
) STRICT;
CREATE TABLE human_ref_registry (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  next_value TEXT NOT NULL
) STRICT;
CREATE TABLE lease_material_proofs (
  account TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  record TEXT NOT NULL
) STRICT;
CREATE TABLE login_flows (
  id                TEXT PRIMARY KEY,
  account           TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  harness           TEXT NOT NULL,
  provider          TEXT,
  revision          INTEGER NOT NULL DEFAULT 1,
  method_id         TEXT,
  methods           TEXT NOT NULL DEFAULT '[]',
  phase             TEXT NOT NULL CHECK (phase IN ('starting','waiting_browser','waiting_device','waiting_input','validating','succeeded','failed','cancelled','expired','interrupted')),
  detail            TEXT,
  authorization_url TEXT,
  user_code         TEXT,
  input_fields      TEXT NOT NULL DEFAULT '[]',
  error             TEXT,
  retryable         INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0,1)),
  remote            INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0,1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  completed_at      INTEGER
) STRICT;
CREATE TABLE mail_history_enqueues (
  seq              INTEGER PRIMARY KEY,
  message_id       INTEGER NOT NULL UNIQUE,
  bee_id            TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('mail.send','spawn.prompt','legacy.unknown','handoff.seed','action.dispatch','auth.resume','quota.resume')),
  sender            BLOB NOT NULL,
  sender_truncated  INTEGER NOT NULL CHECK (sender_truncated IN (0, 1)),
  body              BLOB NOT NULL,
  body_truncated    INTEGER NOT NULL CHECK (body_truncated IN (0, 1)),
  priority          INTEGER NOT NULL,
  urgency           TEXT NOT NULL CHECK (urgency IN ('now','next','idle')),
  enqueued_at       INTEGER NOT NULL
) STRICT;
CREATE TABLE mailbox (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bee_id               TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  sender               TEXT NOT NULL,
  body                 TEXT NOT NULL,
  -- Q2: the reserved tier column. Kept for compat; its ROLE is superseded by
  -- urgency (the 2026-08-18 amendment) and it is consulted by nothing.
  priority             INTEGER NOT NULL DEFAULT 0,
  -- v8: delivery urgency — governs WHEN a message becomes eligible for
  -- delivery (now = interrupt then deliver; next = next accept point;
  -- idle = only while the runtime is not running). Never reorders FIFO:
  -- among ELIGIBLE messages, enqueue order (id) wins.
  urgency              TEXT NOT NULL DEFAULT 'next' CHECK (urgency IN ('now','next','idle')),
  enqueued_at          INTEGER NOT NULL,
  delivered_at         INTEGER,
  delivered_generation INTEGER,
  sender_kind          TEXT CHECK (sender_kind IN ('human','automation'))
) STRICT;
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE multiline_delivery (
  message_id INTEGER PRIMARY KEY,
  bee_id TEXT NOT NULL,
  held_at INTEGER,
  held_since INTEGER,
  sender_notice_message_id INTEGER,
  row_json TEXT NOT NULL
) STRICT;
CREATE TABLE naming_usage (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  bee_id                       TEXT,
  backend                      TEXT NOT NULL,
  provider                     TEXT NOT NULL,
  model                        TEXT NOT NULL,
  status                       TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  latency_ms                   INTEGER NOT NULL CHECK (latency_ms >= 0),
  input_tokens                 INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens          INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  cache_write_input_tokens     INTEGER CHECK (cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0),
  output_tokens                INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens             INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens                 INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  input_rate_nano_usd          INTEGER CHECK (input_rate_nano_usd IS NULL OR input_rate_nano_usd >= 0),
  cached_input_rate_nano_usd   INTEGER CHECK (cached_input_rate_nano_usd IS NULL OR cached_input_rate_nano_usd >= 0),
  cache_write_rate_nano_usd    INTEGER CHECK (cache_write_rate_nano_usd IS NULL OR cache_write_rate_nano_usd >= 0),
  output_rate_nano_usd         INTEGER CHECK (output_rate_nano_usd IS NULL OR output_rate_nano_usd >= 0),
  estimated_cost_nano_usd      INTEGER CHECK (estimated_cost_nano_usd IS NULL OR estimated_cost_nano_usd >= 0),
  response_id                  TEXT,
  request_id                   TEXT,
  error                        TEXT,
  recorded_at                  INTEGER NOT NULL
) STRICT;
CREATE TABLE phone_admission_bindings (
  key TEXT PRIMARY KEY, verb TEXT NOT NULL, lane TEXT NOT NULL, request_digest TEXT NOT NULL
) STRICT;
CREATE TABLE phone_inputs (
  message_id INTEGER PRIMARY KEY, admission_id TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES mail_history_enqueues(message_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE phone_spawn_origins (
  bee_id TEXT PRIMARY KEY REFERENCES bees(id) ON DELETE CASCADE, origin_json TEXT NOT NULL
) STRICT;
CREATE TABLE question_withdraw_receipts (
  bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  question_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bee_id, key)
) STRICT;
CREATE TABLE questions (
  id                  TEXT PRIMARY KEY,
  bee_id              TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  generation          INTEGER,
  text                TEXT NOT NULL,
  options             TEXT,
  status              TEXT NOT NULL CHECK (status IN ('open','answered','withdrawn')),
  answer              TEXT,
  asked_at            INTEGER NOT NULL,
  answered_at         INTEGER,
  answered_by         TEXT,
  delivery_message_id INTEGER,
  withdrawal_reason   TEXT,
  withdrawn_at        INTEGER,
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK ((status = 'withdrawn') = (withdrawal_reason IS NOT NULL)),
  CHECK (status <> 'withdrawn' OR (answer IS NULL AND answered_at IS NULL AND answered_by IS NULL AND delivery_message_id IS NULL)),
  CHECK ((status = 'answered') = (answered_at IS NOT NULL))
) STRICT;
CREATE TABLE quota_recoveries (
  id TEXT PRIMARY KEY,
  bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('waiting','rotating','resumed','cancelled')),
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE rpc_effect_keys (key TEXT PRIMARY KEY, verb TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('committed','fenced')), receipt TEXT, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE rpc_execution_bees (bee_id TEXT PRIMARY KEY, binding TEXT NOT NULL) STRICT;
CREATE TABLE rpc_execution_claims (issuer_id TEXT NOT NULL, continuation_id TEXT NOT NULL, claim TEXT NOT NULL, PRIMARY KEY(issuer_id,continuation_id)) STRICT;
CREATE TABLE rpc_execution_coordinators (issuer_id TEXT PRIMARY KEY, uid INTEGER NOT NULL) STRICT;
CREATE TABLE rpc_execution_effects (key TEXT PRIMARY KEY, binding TEXT NOT NULL, receipt TEXT NOT NULL, command_id INTEGER UNIQUE) STRICT;
CREATE TABLE rpc_execution_refusals (digest TEXT PRIMARY KEY, receipt TEXT NOT NULL) STRICT;
CREATE TABLE rpc_execution_start_ops (lease_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL) STRICT;
CREATE TABLE rpc_execution_starts (intent_id TEXT PRIMARY KEY, bee_id TEXT NOT NULL, runtime_generation INTEGER NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL, host TEXT, agent TEXT, UNIQUE(bee_id,runtime_generation)) STRICT;
CREATE TABLE rpc_execution_transitions (issuer_id TEXT NOT NULL, transition_id TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(issuer_id,transition_id)) STRICT;
CREATE TABLE rpc_idempotency (
  key        TEXT PRIMARY KEY,
  verb       TEXT NOT NULL,
  command_id INTEGER,
  result     TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE runtime_observation_cursors (
  bee_id     TEXT NOT NULL,
  generation INTEGER NOT NULL,
  cursor      INTEGER NOT NULL CHECK (cursor >= 0),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (bee_id, generation),
  FOREIGN KEY (bee_id, generation) REFERENCES runtimes(bee_id, generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE runtimes (
  bee_id         TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  generation     INTEGER NOT NULL CHECK (generation >= 1),
  state          TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
  exit_cause     TEXT CHECK (exit_cause IN ('clean','crashed','stopped_by_user','stopped_by_system','machine_restart')),
  pid            INTEGER,
  pid_started_at INTEGER,
  -- v9: how this runtime left booting (NULL = it has not). 'synthetic' =
  -- only a driver-minted observation (readyAtSpawn spawn-event booted) —
  -- provisional: the process has proven nothing; its crashed/clean exit
  -- counts against the bee's spawn-failure budget like a booting exit.
  -- 'real' = the adapter parsed actual process output — the contrary
  -- evidence that resets the budget and clears spawn_failed.
  boot_evidence  TEXT CHECK (boot_evidence IN ('synthetic','real')),
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL, credential_stamp TEXT, process_identity TEXT,
  PRIMARY KEY (bee_id, generation),
  CHECK ((state = 'stopped') = (exit_cause IS NOT NULL))
) STRICT;
CREATE TABLE seals (
  id         TEXT PRIMARY KEY,
  bee_id     TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  generation INTEGER,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  refs       TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE selection_cursors (
  harness         TEXT PRIMARY KEY,
  last_account_id TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;
CREATE TABLE task_supply (
  bee_id     TEXT PRIMARY KEY REFERENCES bees(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  feed_limit INTEGER NOT NULL DEFAULT 5,
  feeds      INTEGER NOT NULL DEFAULT 0,
  paused     INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1))
) STRICT;
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  list                TEXT NOT NULL,
  bee_id              TEXT REFERENCES bees(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  body                TEXT,
  context             TEXT,
  origin_kind         TEXT NOT NULL CHECK (origin_kind IN ('user','self','bee')),
  origin_sender       TEXT NOT NULL,
  auto                INTEGER NOT NULL CHECK (auto IN (0,1)),
  status              TEXT NOT NULL CHECK (status IN ('pending','queued','in-progress','done','blocked','cancelled')),
  claimed_by          TEXT,
  sort_order          REAL NOT NULL,
  quest_id            TEXT,
  mailbox_message_id  INTEGER,
  fed_at              INTEGER,
  stalled_at          INTEGER,
  blocked_reason      TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  closed_at           INTEGER
) STRICT;
CREATE TABLE templates (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('personal','team','repo')),
  source           TEXT NOT NULL,
  description      TEXT,
  agent            TEXT NOT NULL,
  substrate        TEXT,
  model            TEXT,
  effort           TEXT,
  args             TEXT NOT NULL DEFAULT '[]',
  prompt           TEXT NOT NULL,
  preamble         TEXT,
  preamble_enabled INTEGER NOT NULL DEFAULT 1 CHECK (preamble_enabled IN (0,1)),
  cwd_policy       TEXT NOT NULL CHECK (cwd_policy IN ('caller','fixed')),
  cwd              TEXT,
  env              TEXT NOT NULL DEFAULT '{}',
  account          TEXT,
  yolo             INTEGER NOT NULL DEFAULT 0 CHECK (yolo IN (0,1)),
  tags             TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((cwd_policy = 'fixed') = (cwd IS NOT NULL)),
  UNIQUE (scope, name)
) STRICT;
CREATE TABLE thread_operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  successor_bee_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK (phase IN ('copying','compacting','starting','ready','failed')),
  row_json TEXT NOT NULL
) STRICT;
CREATE TABLE tracks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('personal','team','repo')),
  source      TEXT NOT NULL,
  description TEXT,
  steps       TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (scope, name)
) STRICT;
CREATE TABLE transcript_segments (
  id                   TEXT PRIMARY KEY,
  bee_id               TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  ordinal              INTEGER NOT NULL CHECK (ordinal >= 0),
  harness              TEXT NOT NULL,
  provider_session_id  TEXT,
  from_generation      INTEGER NOT NULL CHECK (from_generation >= 1),
  to_generation        INTEGER,
  path                 TEXT,
  handoff_id           TEXT,
  created_at           INTEGER NOT NULL,
  closed_at            INTEGER,
  UNIQUE (bee_id, ordinal)
) STRICT;
CREATE INDEX account_admission_active
  ON account_admission_reservations(account, expires_at)
  WHERE released_at IS NULL;
CREATE INDEX accounts_harness ON accounts(harness, added_at, id);
CREATE UNIQUE INDEX accounts_native_harness ON accounts(harness) WHERE native = 1;
CREATE INDEX actions_bee_status ON actions(bee_id, status, position);
CREATE INDEX actions_dispatch_message ON actions(dispatch_message_id) WHERE dispatch_message_id IS NOT NULL;
CREATE INDEX actions_open ON actions(bee_id, position) WHERE status IN ('queued','running','waiting');
CREATE INDEX actions_question ON actions(question_id) WHERE question_id IS NOT NULL;
CREATE INDEX audit_bee_deleted_bee_seq
  ON audit(bee_id, seq DESC)
  WHERE kind = 'bee.deleted';
CREATE INDEX audit_by_bee
  ON audit(bee_id) WHERE bee_id IS NOT NULL;
CREATE INDEX audit_mail_canceled_message_seq
  ON audit(CAST(json_extract(payload, '$.messageId') AS INTEGER), seq DESC)
  WHERE kind = 'mail.canceled';
CREATE INDEX audit_mail_delivered_message_seq
  ON audit(CAST(json_extract(payload, '$.messageId') AS INTEGER), seq DESC)
  WHERE kind = 'mail.delivered';
CREATE INDEX audit_mail_enqueued_seq
  ON audit(seq DESC) WHERE kind = 'mail.enqueued';
CREATE INDEX audit_mail_expedited_message_seq
  ON audit(CAST(json_extract(payload, '$.messageId') AS INTEGER), seq DESC)
  WHERE kind = 'mail.expedited';
CREATE INDEX audit_tmux_cleanup ON audit(seq) WHERE kind IN ('runtime.tmux_cleanup_retained','runtime.tmux_cleanup_unverifiable','runtime.tmux_cleanup_resolved');
CREATE INDEX auth_interruptions_by_bee ON auth_interruptions(bee_id, id);
CREATE UNIQUE INDEX auth_interruptions_live
  ON auth_interruptions(bee_id) WHERE state IN ('open','restored','resumed');
CREATE INDEX bee_handoffs_bee ON bee_handoffs(bee_id, created_at);
CREATE INDEX bees_auto_title_candidates ON bees(lifecycle, id, title)
  WHERE lifecycle = 'active' AND (title IS NULL OR title = '');
CREATE INDEX bees_by_lifecycle ON bees(lifecycle, id);
CREATE INDEX bees_handle ON bees(handle) WHERE handle IS NOT NULL;
CREATE UNIQUE INDEX bees_human_ref ON bees(human_ref COLLATE NOCASE) WHERE human_ref IS NOT NULL;
CREATE UNIQUE INDEX bees_one_active_handoff ON bees(active_handoff_id) WHERE active_handoff_id IS NOT NULL;
CREATE UNIQUE INDEX bees_one_active_move ON bees(active_move_id) WHERE active_move_id IS NOT NULL;
CREATE INDEX commands_by_bee ON commands(bee_id, id);
CREATE INDEX commands_by_bee_status ON commands(bee_id, status, id);
CREATE UNIQUE INDEX commands_idempotency_key
  ON commands(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX commands_ready ON commands(status, next_attempt_at, id);
CREATE INDEX commands_stop_recovery
  ON commands(bee_id, target_generation) WHERE verb = 'stop' AND status IN ('done','running');
CREATE INDEX credential_handoffs_account ON credential_handoffs(account);
CREATE INDEX credential_handoffs_state ON credential_handoffs(state,role);
CREATE INDEX flags_active ON flags(bee_id, flag) WHERE cleared_at IS NULL;
CREATE INDEX flags_due ON flags(resets_at, id)
WHERE cleared_at IS NULL AND resets_at IS NOT NULL;
CREATE INDEX login_flows_account ON login_flows(account, created_at);
CREATE INDEX mailbox_delivered_by_bee
  ON mailbox(bee_id) WHERE delivered_at IS NOT NULL;
CREATE INDEX mailbox_pending_metadata ON mailbox(bee_id, id, urgency, enqueued_at, delivered_at) WHERE delivered_at IS NULL;
CREATE INDEX multiline_delivery_bee ON multiline_delivery(bee_id, held_at);
CREATE INDEX multiline_delivery_blocked ON multiline_delivery(message_id) WHERE held_since IS NOT NULL;
CREATE INDEX multiline_delivery_hold ON multiline_delivery(bee_id, held_since);
CREATE UNIQUE INDEX multiline_delivery_notice ON multiline_delivery(sender_notice_message_id);
CREATE INDEX naming_usage_bee ON naming_usage(bee_id, recorded_at) WHERE bee_id IS NOT NULL;
CREATE INDEX naming_usage_recorded ON naming_usage(recorded_at, id);
CREATE INDEX questions_delivery_message ON questions(delivery_message_id) WHERE delivery_message_id IS NOT NULL;
CREATE INDEX questions_open ON questions(bee_id, asked_at) WHERE status = 'open';
CREATE INDEX quota_recoveries_by_bee ON quota_recoveries(bee_id, id);
CREATE INDEX quota_recoveries_live ON quota_recoveries(bee_id) WHERE state IN ('waiting','rotating');
CREATE INDEX rpc_idempotency_created_at ON rpc_idempotency(created_at);
CREATE INDEX runtimes_daemon_live
  ON runtimes(bee_id, generation) WHERE state != 'stopped';
CREATE INDEX seals_bee ON seals(bee_id, created_at);
CREATE INDEX tasks_bee ON tasks(bee_id, sort_order, id) WHERE bee_id IS NOT NULL;
CREATE INDEX tasks_list ON tasks(list, sort_order, id);
CREATE INDEX thread_operations_phase ON thread_operations(phase);
