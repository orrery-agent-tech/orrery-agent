-- Wave R1 markets (docs/ORRY-R1-SPEC.md section 5): MarketFactory and SealedBatchMarket events at the confirmation
-- depth, and the tables derived from them. Amounts are numeric base units.

create table if not exists market_events (
  block_number bigint      not null,
  log_index    integer     not null,
  tx_hash      text        not null,
  address      text        not null,
  event        text        not null,
  args         jsonb       not null,
  block_time   timestamptz not null,
  primary key (block_number, log_index)
);
create index if not exists market_events_event on market_events(event, address);

-- One row per market the factory created, with its constructor values (a market has no setters). Batch n's reveal
-- window ends at reveal_end0 + n * period, as the market's own revealEnd(0) and revealEnd(1) say.
create table if not exists markets (
  market          text    primary key,
  asset           text    not null unique,
  price_feed      text    not null,
  usdg            text    not null,
  symbol          text    not null,
  name            text    not null,
  decimals        integer not null,
  reveal_end0     bigint  not null,
  period          bigint  not null check (period > 0),
  commit_seconds  integer not null,
  reveal_seconds  integer not null,
  fee_bps         integer not null,
  min_notional    numeric not null,
  commit_fee_usd  numeric not null,
  max_staleness   integer not null,
  max_orders      integer not null,
  expiry_seconds  bigint  not null,
  created_block   bigint  not null,
  created_tx      text    not null
);

create table if not exists market_batches (
  market        text    not null,
  batch         numeric not null,
  commits       integer not null default 0 check (commits >= 0),
  reveals       integer not null default 0 check (reveals >= 0),
  commit_fees   numeric not null default 0,
  cleared       boolean not null default false,
  price         numeric,
  round_id      numeric,
  asset_filled  numeric,
  usdg_filled   numeric,
  usdg_fees     numeric not null default 0,
  orry_fees    numeric not null default 0,
  filled        integer not null default 0,
  dropped       integer not null default 0,
  cleared_tx    text,
  cleared_block bigint,
  cleared_time  timestamptz,
  expired       boolean not null default false,
  primary key (market, batch)
);

-- One commitment per address per batch (the market allows no second one).
create table if not exists market_orders (
  market           text        not null,
  batch            numeric     not null,
  account          text        not null,
  commitment       text        not null,
  commit_tx        text        not null,
  commit_block     bigint      not null,
  committed_at     timestamptz not null,
  commit_fee       numeric     not null default 0,
  revealed         boolean     not null default false,
  sell_asset       boolean,
  amount_in        numeric,
  limit_price      numeric,
  mode             smallint,
  pay_fee_in_orry boolean,
  reveal_tx        text,
  outcome          text check (outcome in ('filled', 'dropped')),
  input_used       numeric,
  output           numeric,
  usdg_fee         numeric,
  orry_fee        numeric,
  fill_tx          text,
  primary key (market, batch, account)
);
create index if not exists market_orders_account on market_orders(account, commit_block desc);
