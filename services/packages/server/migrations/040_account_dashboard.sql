-- Dashboard credits (owner, 2026-11-11): a wallet signs in once to read its credits, purchases and usage. A session reads;
-- it never spends a check, issues a key or moves anything.

-- Checks per address per UTC day, written in the same transaction that meters each check (spendCheck).
create table if not exists check_usage_daily (
  address        text    not null,
  day            date    not null,
  checks         bigint  not null default 0,
  free_checks    bigint  not null default 0,
  credits_spent  bigint  not null default 0,
  primary key (address, day)
);

-- Read sessions for the dashboard, stored hashed like API keys.
create table if not exists account_sessions (
  token_hash  text        primary key,
  address     text        not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists account_sessions_address on account_sessions (address);

-- A nonce is signed for one purpose: rotating the API key, or opening a read session. Neither signature works for the other.
alter table key_nonces add column if not exists purpose text not null default 'rotate';
