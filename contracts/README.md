# Orrery contracts

`OrreryPolicyModule` (ERC-7579 executor with capped, public spending authority for an agent signer), `OrreryAttestor`
(verification fee, liveness attestations, attester and check-signer keys) and `OrreryLens` (read view for checks).
Spec: `../08-contract-spec.md` revision 3. Invariants: `../09-invariants.md`.

Status 2026-11-06: built and tested locally; nothing deployed, no keys, branch `build/v1` (local only).

## Commands

```bash
heavy forge build
heavy forge test --no-match-path 'test/fork/*'          # unit, invariant campaign, deterministic deep run
heavy forge test --match-path 'test/fork/*' --fork-url https://rpc-robinhood.blockmachine.io --fork-retries 10 --fork-retry-backoff 3000
python3 mutate.py                                        # 49 mutations, about 25 minutes
```

The fork suite needs an RPC that serves recent state reliably. On 2026-11-06 blockmachine worked (it rate-limits at
60 requests a minute, so wait a minute between runs); Pocket and globalstake failed with missing historical state.

## Results (2026-11-06)

| Layer | Result |
| :--- | :--- |
| Unit and review regressions | 70 passed (module lifecycle, open, changes, agent calls, attestor, lens, extras, code-review fixes, the reviewer's proof tests now passing) |
| Invariant campaign | 4 invariants, 256 runs, 30,720 calls, 0 failures |
| Deterministic deep run | 4,000 weighted actions: 90 opens, 85 top-ups, 74 executes, 48 decreases, 49 proposals, 7 applied increases, 31 revokes, 5 pauses, 67 uninstall cycles, 32 identity transfers, 64 UTC days; all invariants hold |
| Mutation | 49 of 49 caught (first pass 36/38, two tests added; after the code review 11 new mutations, one test added) |
| Fork, Robinhood Chain 4663 | 4 passed: real ERC-8004 IdentityRegistry (binding via ERC-1271 from a Safe through the Safe7579 adapter, cleared on NFT transfer with a `MetadataSet` event), real USDG, Safe 1.4.1 + Safe7579 v1.0.0 (install via `initializeAccount`, `executeFromExecutor`, uninstall revokes all sessions), lens recognises the real Safe7579, adapter and Permit2 refused as targets. `topUp` of USDG used 175,670 gas after the code-review fixes (about $0.008 at 0.02 gwei and ETH $2,246). L2 block about 107.65 M; inside the EVM `block.number` reads 26,356,394 because Arbitrum chains return the L1 block number (the module uses only `block.timestamp`) |
| Code review | Fresh-context reviewer: 1 High, 4 Medium, 5 Low, all fixed (`../10-spec-review.md`, section "Code review") |
| Static analysis | Not run (Slither is not installed) |

## Invariant coverage

| Ids | Covered by |
| :--- | :--- |
| A1, A2, A3, A4 | Handler ghosts and flags (`invariant_spentEqualsOutflow`, `invariant_flags`), unit `test_topUp_*`, `test_execute_*` |
| A5, H1 | `test_hostile_tokens_rejected_on_topUp` |
| A6 | Implied by A1 with fixed UTC buckets; no separate sliding-window test |
| A7 | `invariant_moduleHoldsNothing` (module); attestor holds no balance by construction (fee goes straight to treasury) |
| A8, X3 | `test_forbidden_selectors`, `test_forbidden_targets`, `test_execute_rechecks_installed_modules`, handler allowance flag, fork test |
| A9 | Handler `dropTokenAttempt` and flag, `test_propose_rules`, `test_decrease_rejects_increases` |
| A10 | `test_native_outflow_refused_when_native_not_capped` |
| S1 to S7 | Handler flags, lifecycle and agent unit tests, `test_reinstall_without_onUninstall_keeps_old_sessions_revoked` |
| P1 to P6 | Handler `applyIncrease` flag, `invariant_storedPoliciesValid`, change tests, `test_validFor_follows_pending` |
| B1 to B3 | `test_open_requires_binding`, `test_bound_false_after_identity_transfer`, fork end to end |
| B4 | Fork (`Safe7579` recognised, owner flag); unknown accounts in unit tests. Kernel 3.1 not tested |
| X1, X2, X4, X5 | `test_only_the_account_changes_its_sessions`, signer tests, `test_reentrancy_blocked`, attestor tests |
| H2 | Not tested (a token whose `balanceOf` lies) |
| A11, S8, B5 | `test_topUp_checks_the_account_side_too`, `test_consent_required_and_bound_to_signer`, review regressions, `test_lens_hides_stale_attestations`, `test_lens_replaced_signer_shows_no_new_session_data` |
| H3, H4 | `test_execute_counts_outflow_by_balance_delta`, `test_execute_net_and_rise` |
| F1, F2 | `test_pay_verification_moves_exact_fee`, `test_fee_token_must_deliver_exact_fee`, `test_treasury_self_pay_records_zero` |
| V1 to V5 | Services are not built yet |

## Not done

- Kernel 3.1 fork test (08 §11.3); Kernel accounts read as `Unknown` in `OrreryLens`.
- Slither. A second code review of the fixes (the first review's findings are fixed and pinned by tests).
- Deployment scripts; services, SDK and web app (backlog E6 to E10).
