-- Lane L2: what the data indexer reads from the chain (docs/updates/L2-DATA-MCP-SPEC.md 5).

-- Logs of the provider registry, DataFeeSplitter, stock tokens, the stock issuer registry and the Pons factory, at the
-- confirmation depth. `source` names the group.
create table if not exists data_events (
  block_number  bigint      not null,
  log_index     integer     not null,
  tx_hash       text        not null,
  address       text        not null,
  source        text        not null check (source in ('registry', 'splitter', 'stock', 'issuer', 'pons')),
  event         text        not null,
  args          jsonb       not null,
  block_time    timestamptz not null,
  primary key (block_number, log_index)
);
create index if not exists data_events_source on data_events (source, event, block_number desc);

-- Listed providers, kept from Listed / Updated / Unlisted in order.
create table if not exists data_providers (
  provider      text        primary key,
  splitter      text        not null,
  endpoint      text        not null,
  name          text        not null,
  description   text        not null,
  price_usdg    numeric     not null,
  listed_block  bigint      not null,
  listed_tx     text        not null,
  listed_at     timestamptz not null,
  updated_at    timestamptz not null,
  last_forward_at timestamptz
);

-- Block of each settled x402 payment's transaction (read from its receipt), so payment records name their block (DA-1).
create table if not exists data_payment_blocks (
  tx_hash       text        primary key,
  block_number  bigint      not null,
  log_index     integer     not null
);

-- Endpoint probe history (dataset `agents`, view `probes`): the prober keeps only the latest probe per agent in `probes`;
-- this trigger appends every probe it writes, so the prober needs no change.
create table if not exists data_probe_history (
  id                  bigserial   primary key,
  agent_id            numeric     not null,
  probed_at           timestamptz not null,
  endpoints_live      boolean     not null,
  registration_valid  boolean     not null,
  domain_verified     boolean     not null,
  attest_tx           text,
  unique (agent_id, probed_at)
);
create index if not exists data_probe_history_agent on data_probe_history (agent_id, probed_at desc);

create or replace function data_probe_history_append() returns trigger language plpgsql as $$
begin
  insert into data_probe_history (agent_id, probed_at, endpoints_live, registration_valid, domain_verified, attest_tx)
  values (new.agent_id, new.probed_at, new.endpoints_live, new.registration_valid, new.domain_verified, new.attest_tx)
  on conflict (agent_id, probed_at) do update set attest_tx = excluded.attest_tx;
  return new;
end $$;

drop trigger if exists data_probe_history_trg on probes;
create trigger data_probe_history_trg after insert or update on probes
  for each row execute function data_probe_history_append();
