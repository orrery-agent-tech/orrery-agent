-- Runtime release switch (launch plan prep item 3): when each feature opens. opens_at null = held; a feature with no
-- row is held. Written only by scripts/releases.ts (no HTTP write route); every change leaves an audit row.
create table if not exists releases (
  feature    text        primary key,
  opens_at   timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text        not null
);

create table if not exists releases_audit (
  id         bigserial   primary key,
  feature    text        not null,
  opens_at   timestamptz,
  previous   timestamptz,
  had_row    boolean     not null,
  changed_at timestamptz not null default now(),
  changed_by text        not null
);
create index if not exists releases_audit_feature on releases_audit(feature, changed_at);
