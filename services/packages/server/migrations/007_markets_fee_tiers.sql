-- The FeeTiers contract each market reads at clearing (L2, USD thresholds since orry/spec 7ead6cb).
alter table markets add column if not exists fee_tiers text not null default '0x0000000000000000000000000000000000000000';
