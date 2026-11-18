-- Wave 3 public x402 facilitator (R-57, utilities 1, 4, 6, 11): merchants' splitters, the payments settled to them, and
-- the splitters' own events (Forwarded, and Burned with source 7 for ORRY fees).

-- One row per SplitterCreated: a merchant and its payTo. Profile fields come from a message the merchant signs.
create table if not exists merchants (
  merchant            text        primary key,
  splitter            text        not null unique,
  created_block       bigint      not null,
  created_tx          text        not null,
  created_at          timestamptz not null,
  name                text,
  url                 text,
  description         text,
  profile_updated_at  timestamptz,
  last_forward_at     timestamptz
);

-- Settlements the facilitator made: one row per (asset, payer, nonce), written before the broadcast so a second
-- worker never sends the same authorization twice.
create table if not exists facilitator_payments (
  asset       text        not null,
  payer       text        not null,
  nonce       text        not null,
  pay_to      text        not null,
  amount      numeric     not null,
  method      text        not null check (method in ('eip3009', 'permit2')),
  status      text        not null check (status in ('pending', 'settled', 'failed')),
  tx_hash     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (asset, payer, nonce)
);
create index if not exists facilitator_payments_pay_to on facilitator_payments (pay_to, created_at);

-- Factory and splitter events at the confirmation depth.
create table if not exists facilitator_events (
  block_number  bigint      not null,
  log_index     integer     not null,
  tx_hash       text        not null,
  address       text        not null,
  event         text        not null,
  args          jsonb       not null,
  block_time    timestamptz not null,
  primary key (block_number, log_index)
);
create index if not exists facilitator_events_event on facilitator_events (event, address);

-- Single-use nonces for the merchant profile message.
create table if not exists merchant_profile_nonces (
  merchant    text        primary key,
  nonce       text        not null,
  expires_at  timestamptz not null
);
