-- Check pricing (R-58): a free monthly allowance per address, a volume rate past a monthly threshold, and a platform plan.
-- Credits keep their unit (1 USDG buys `ORRERY_PACK_SIZE` credits, ORRY checkout 625 per USD); a check costs
-- `creditsPerCheck`, or `volumeCreditsPerCheck` past the threshold or while a plan is active.

-- Checks per address per UTC month; `free_checks` of them came from the monthly allowance.
create table if not exists check_usage (
  address      text        not null,
  month        date        not null,
  checks       bigint      not null default 0,
  free_checks  bigint      not null default 0,
  primary key (address, month)
);

-- Checks per UTC day across all addresses: caps the free allowance in total and feeds the checks-per-day KPI (R-62).
create table if not exists check_days (
  day          date        primary key,
  free_checks  bigint      not null default 0,
  paid_checks  bigint      not null default 0
);

alter table credit_accounts add column if not exists plan_until timestamptz;
alter table credit_grants add column if not exists kind text not null default 'pack' check (kind in ('pack', 'plan'));
