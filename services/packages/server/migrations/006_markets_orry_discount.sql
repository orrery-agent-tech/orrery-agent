-- L3 (R-24): the further discount on a fee paid in ORRY, a market constructor value (orry/spec 3472eb1).
alter table markets add column if not exists orry_fee_discount_bps integer not null default 0;
