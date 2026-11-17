-- Orrery services schema, version 1.
create table if not exists payments (
  payer       text        not null,
  nonce       text        not null,
  amount      numeric     not null,
  status      text        not null check (status in ('pending', 'settled', 'failed')),
  tx_hash     text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (payer, nonce)
);

create table if not exists credit_accounts (
  address     text        primary key,
  credits     bigint      not null default 0 check (credits >= 0),
  created_at  timestamptz not null default now()
);

create table if not exists credit_grants (
  payer       text        not null,
  nonce       text        not null,
  credits     integer     not null,
  created_at  timestamptz not null default now(),
  primary key (payer, nonce)
);

create table if not exists api_keys (
  key_hash    text        primary key,
  address     text        not null references credit_accounts(address),
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists api_keys_one_active on api_keys(address) where active;

create table if not exists key_nonces (
  nonce       text        primary key,
  address     text        not null,
  expires_at  timestamptz not null,
  used        boolean     not null default false
);

create table if not exists probes (
  agent_id            numeric     primary key,
  probed_at           timestamptz not null,
  endpoints_live      boolean     not null,
  registration_valid  boolean     not null,
  domain_verified     boolean     not null,
  registration_hash   text        not null,
  detail              jsonb       not null default '{}'::jsonb,
  attested_at         timestamptz,
  attest_tx           text
);

create table if not exists chain_events (
  block_number bigint      not null,
  log_index    integer     not null,
  tx_hash      text        not null,
  address      text        not null,
  event        text        not null,
  args         jsonb       not null,
  primary key (block_number, log_index)
);
create index if not exists chain_events_event on chain_events(event);

create table if not exists indexer_state (
  id          text        primary key,
  last_block  bigint      not null,
  head_block  bigint      not null,
  updated_at  timestamptz not null default now()
);
