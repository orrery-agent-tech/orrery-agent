-- Lane L3, wave R2 prediction markets (docs/updates/L3-R2-SPEC.md section 3): events of the factory, the markets it made,
-- the limit order book and the paymasters (one table for all R2 events, cursor 'r2' in indexer_state), and the tables
-- derived from them. Amounts are numeric base units.

create table if not exists r2_events (
  block_number bigint      not null,
  log_index    integer     not null,
  tx_hash      text        not null,
  address      text        not null,
  event        text        not null,
  args         jsonb       not null,
  block_time   timestamptz not null,
  primary key (block_number, log_index)
);
create index if not exists r2_events_event on r2_events(event, address);

create table if not exists predict_feeds (
  feed        text    primary key,
  asset       text    not null,
  description text    not null,
  decimals    integer not null,
  listed_block bigint not null
);

-- One row per market contract (custody pattern C: each market is its own contract and holds only its own stakes).
create table if not exists predict_markets (
  market        text        primary key,
  feed          text        not null,
  asset         text        not null,
  strike        numeric     not null,
  close_time    bigint      not null,
  lock_time     bigint      not null,
  created_time  timestamptz not null,
  creator       text        not null,
  creation_burn numeric     not null default 0,
  fee_bps       integer     not null,
  min_stake     numeric     not null,
  yes_pool      numeric     not null default 0,
  no_pool       numeric     not null default 0,
  stakers       integer     not null default 0,
  status        text        not null default 'open' check (status in ('open', 'yes', 'no', 'refund')),
  settle_price  numeric,
  settle_round  numeric,
  settled_tx    text,
  settled_time  timestamptz,
  usdg_fees     numeric     not null default 0,
  orry_fees    numeric     not null default 0,
  paid_out      numeric     not null default 0,
  swept         numeric     not null default 0,
  created_block bigint      not null,
  created_tx    text        not null
);
create index if not exists predict_markets_close on predict_markets(status, close_time);

create table if not exists predict_positions (
  market     text    not null,
  account    text    not null,
  yes        numeric not null default 0,
  no         numeric not null default 0,
  claimed    boolean not null default false,
  payout     numeric,
  usdg_fee   numeric,
  orry_fee  numeric,
  claim_tx   text,
  primary key (market, account)
);
create index if not exists predict_positions_account on predict_positions(account);
