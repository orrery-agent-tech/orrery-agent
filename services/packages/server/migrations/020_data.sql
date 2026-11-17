-- Lane L2: Orrery Data packs (R-49 to R-52, R-60; docs/updates/L2-DATA-MCP-SPEC.md 1 and 5). Amounts are base units.

-- Data calls left per address. Spent one at a time by an atomic update that never goes below zero.
create table if not exists data_accounts (
  address     text        primary key,
  calls       bigint      not null default 0 check (calls >= 0),
  updated_at  timestamptz not null default now()
);

-- One row per pack payment, written before the broadcast (status pending) so a second worker never sends the same
-- authorization twice; calls are granted once, in the same transaction that marks it settled.
create table if not exists data_payments (
  asset       text        not null,
  payer       text        not null,
  nonce       text        not null,
  pay_to      text        not null,
  amount      numeric     not null,
  method      text        not null check (method in ('eip3009', 'permit2')),
  quote_id    text,
  status      text        not null check (status in ('pending', 'settled', 'failed')),
  calls       bigint,
  tx_hash     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (asset, payer, nonce)
);
create index if not exists data_payments_status on data_payments (status, created_at);

-- ORRY pack quotes (D-4): the amount named in an x402 requirement, valid until expires_at, used once.
create table if not exists data_orry_quotes (
  quote_id    text        primary key,
  amount      numeric     not null,
  usd         numeric     not null,
  expires_at  timestamptz not null,
  used_by     text,
  created_at  timestamptz not null default now()
);
create index if not exists data_orry_quotes_expiry on data_orry_quotes (expires_at);
