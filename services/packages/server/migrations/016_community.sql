-- Lane L1 Community (docs/updates/L1-COMMUNITY-SPEC.md): the L1 contracts' events at the confirmation depth and the
-- tables derived from them. Amounts are numeric base units; USD values are USDG base units (6 decimals).

create table if not exists community_events (
  block_number bigint      not null,
  log_index    integer     not null,
  tx_hash      text        not null,
  address      text        not null,
  source       text        not null,
  event        text        not null,
  args         jsonb       not null,
  block_time   timestamptz not null,
  primary key (block_number, log_index)
);
create index if not exists community_events_event on community_events (source, event, block_time);

create table if not exists community_rooms (
  id            integer primary key,
  name          text    not null,
  min_stake_usd numeric not null
);

-- Messages: the text is the event's text. `reports` and `hidden` follow the chat's Reported and Hidden events (R-32).
create table if not exists community_messages (
  id         numeric     primary key,
  room       integer     not null,
  author     text        not null,
  reply_to   numeric,
  text       text        not null,
  fee        numeric     not null,
  tips       numeric     not null default 0,
  reports    integer     not null default 0,
  hidden     boolean     not null default false,
  block_time timestamptz not null,
  tx_hash    text        not null
);
create index if not exists community_messages_room on community_messages (room, id desc);

create table if not exists community_names (
  address    text        primary key,
  name       text        not null,
  updated_at timestamptz not null
);

-- Protocol fees paid through the L1 contracts and OrreryAttestor verifications, one row per fee, valued in USD at payment
-- (constructor prices for L1, the USDG fee for a verification). The "most active" ranking (R-34) adds the other
-- products' fees from their own tables.
create table if not exists community_fees (
  tx_hash    text        not null,
  log_index  integer     not null,
  account    text        not null,
  source     text        not null,
  usd        numeric     not null,
  orry      numeric     not null default 0,
  block_time timestamptz not null,
  primary key (tx_hash, log_index)
);
create index if not exists community_fees_account_time on community_fees (account, block_time);
create index if not exists community_fees_time on community_fees (block_time);

-- Reward Pool events (R-33).
create table if not exists community_pool_events (
  id          integer     primary key,
  asset       text        not null,
  kind        integer     not null,
  amount      numeric     not null,
  deadline    timestamptz not null,
  rules_hash  text        not null,
  status      text        not null check (status in ('open', 'published', 'expired')),
  payable_at  timestamptz,
  winners     jsonb       not null default '[]'::jsonb,
  created_at  timestamptz not null
);

create table if not exists community_achievements (
  id              integer     primary key,
  asset           text        not null,
  kind            integer     not null,
  verifier        text,
  reward_per_user numeric     not null,
  max_recipients  integer     not null,
  deadline        timestamptz not null,
  rules_hash      text        not null,
  closed          boolean     not null default false,
  created_at      timestamptz not null
);

create table if not exists community_achievement_claims (
  id           integer     not null,
  account      text        not null,
  completed_at timestamptz not null,
  rank         integer     not null,
  amount       numeric     not null,
  block_time   timestamptz not null,
  primary key (id, account)
);

create table if not exists community_listed (
  id           integer     not null,
  account      text        not null,
  completed_at timestamptz not null,
  listed_at    timestamptz not null,
  primary key (id, account)
);

create table if not exists community_boosts (
  kind   integer     not null,
  target numeric     not null,
  until  timestamptz not null,
  primary key (kind, target)
);

create table if not exists community_passes (
  account text        primary key,
  until   timestamptz not null
);

create table if not exists community_templates (
  id           integer     primary key,
  creator      text        not null,
  price_usd    numeric     not null,
  content_hash text        not null,
  uri          text        not null,
  listed       boolean     not null default true,
  sales        integer     not null default 0,
  created_at   timestamptz not null
);

create table if not exists community_licences (
  id         integer     not null,
  buyer      text        not null,
  paid       numeric     not null,
  block_time timestamptz not null,
  primary key (id, buyer)
);

create table if not exists community_referrals (
  referee   text        primary key,
  referrer  text        not null,
  linked_at timestamptz not null
);
create index if not exists community_referrals_referrer on community_referrals (referrer);

-- Accruals as the cashback sink recorded them (Accrued events), and the months it opened.
create table if not exists community_accruals (
  ref         text        not null,
  kind        integer     not null,
  account     text        not null,
  referee     text,
  month       integer     not null,
  fee_usd     numeric     not null,
  reward_usd  numeric     not null,
  fee_paid_at timestamptz not null,
  tx_hash     text        not null,
  primary key (ref, kind, account)
);
create index if not exists community_accruals_account on community_accruals (account, month);

create table if not exists community_periods (
  month      integer     primary key,
  total_usd  numeric     not null,
  reserve    numeric     not null,
  opened_at  timestamptz not null,
  closed     boolean     not null default false
);

create table if not exists community_claims (
  account    text        not null,
  month      integer     not null,
  usd        numeric     not null,
  orry      numeric     not null,
  block_time timestamptz not null,
  primary key (account, month)
);
