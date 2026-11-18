-- Lane L3, wave R2 limit orders (docs/updates/L3-R2-SPEC.md section 4). Orders are signatures held off chain: the API
-- stores a signed order after checking it; the keeper fills it through the book once the pool meets its limit. Nothing is
-- escrowed, so a stored order is never a balance.

create table if not exists limit_orders (
  order_hash       text        primary key,
  book             text        not null,
  owner            text        not null,
  asset            text        not null,
  sell_asset       boolean     not null,
  amount_in        numeric     not null,
  limit_price      numeric     not null,
  tip_bps          integer     not null,
  pay_fee_in_orry boolean     not null,
  nonce            numeric     not null,
  expiry           bigint      not null,
  signature        text        not null,
  status           text        not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  amount_out       numeric,
  usdg_fee         numeric,
  orry_fee        numeric,
  tip              numeric,
  keeper           text,
  fill_tx          text,
  last_try         timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  unique (book, owner, nonce)
);
create index if not exists limit_orders_owner on limit_orders(owner, created_at desc);
create index if not exists limit_orders_open on limit_orders(status, asset);

-- Fills and cancellations seen on chain, whether or not the order was stored here (an order may be filled by anyone).
create table if not exists limit_nonces (
  book    text    not null,
  owner   text    not null,
  nonce   numeric not null,
  outcome text    not null check (outcome in ('filled', 'cancelled')),
  tx      text    not null,
  primary key (book, owner, nonce)
);
