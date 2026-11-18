-- Lane L3, Shield V2 (docs/updates/L3-R2-SPEC.md section 6): the shield's events live in r2_events like every R2
-- contract's; a wallet rebuilds its notes by reading them in chain order, so they are read by (address, position).
create index if not exists r2_events_address_order on r2_events(address, block_number, log_index);
