-- Wave R1 after lane M-1's measurements (docs/ORRY-R1-SPEC.md section 7): the remainder pool of Swap orders (R1b),
-- the pool leg of each cleared batch, and the opt-in reveal relay's queue.

alter table markets
  add column if not exists remainder_pool_id text    not null default '0x0000000000000000000000000000000000000000000000000000000000000000',
  add column if not exists remainder_listed  boolean not null default false,
  add column if not exists max_deviation_bps integer not null default 0;

alter table market_batches
  add column if not exists asset_via_pool numeric not null default 0,
  add column if not exists usdg_via_pool  numeric not null default 0;

-- One queued reveal per (market, batch, account): the order and salt a trader handed to the relay. The salt is public
-- once the reveal is on chain; until then it is the order's only secret, so no route ever returns it.
create table if not exists market_relay (
  market      text        not null,
  batch       numeric     not null,
  account     text        not null,
  sell_asset  boolean     not null,
  amount_in   numeric     not null,
  limit_price numeric     not null,
  mode        smallint    not null,
  pay_fee_in_orry boolean not null,
  salt        text        not null,
  status      text        not null default 'queued' check (status in ('queued', 'sent', 'revealed', 'failed')),
  tx          text,
  reason      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (market, batch, account)
);
create index if not exists market_relay_queued on market_relay(status) where status = 'queued';
