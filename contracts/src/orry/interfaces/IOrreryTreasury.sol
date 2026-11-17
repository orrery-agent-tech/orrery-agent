// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Orrery's USDG treasury (`docs/ORRY-BUILD-SPEC.md` 3.5). The owner sets it as `OrreryAttestor.treasury` and as
/// the API's x402 `payTo`, so verification fees and pack payments land here. Every USDG increase is split by `sync`:
/// `OWNER_BPS` (default 1000 = 10%) to the owner, the rest to the buyback reserve (owner decision 2026-11-08: 90% for
/// buyback). Coinless until `executeCoin`: the reserve only accrues and the owner may reclaim it; after the coin is
/// set the reserve can only leave through `pullBuyback`. Also sells check packs and verifications for ORRY, burned.
interface IOrreryTreasury {
    event Synced(uint256 toOwner, uint256 toReserve);
    event OwnerShareWithdrawn(address indexed to, uint256 amount);
    event CoinProposed(address indexed orry, address indexed buyback, uint64 executableAt);
    event CoinSet(address indexed orry, address indexed buyback);
    event ReserveReclaimed(uint256 amount);
    event BuybackPulled(address indexed buyback, uint256 amount);
    event CreditsPaid(address indexed buyer, uint32 packs, uint256 orryAmount, bytes32 indexed quoteId);
    event VerificationBurned(uint256 indexed agentId, address indexed payer, uint256 orryAmount, bytes32 indexed quoteId);
    event QuoteSignerSet(address indexed signer, bool enabled);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotBuyback();
    error CoinAlreadySet();
    error CoinNotSet();
    error NoProposal();
    error ProposalNotReady(uint64 executableAt);
    error ProposalExpired();
    error QuoteExpired();
    error QuoteUsed();
    error BadQuoteSignature();
    error TooManySigners();
    error DailyVerificationCap();
    error InexactBurn();
    error ZeroAmount();
    error ZeroAddress();

    function OWNER_BPS() external view returns (uint16); // 1000
    function COIN_DELAY() external view returns (uint64); // 48 hours
    function COIN_WINDOW() external view returns (uint64); // 7 days after COIN_DELAY
    function PULL_BPS_PER_DAY() external view returns (uint16); // 1000 = 10% of the reserve per 24 hours
    function MAX_ORRY_VERIFICATIONS_PER_DAY() external view returns (uint32); // 25
    function MAX_QUOTE_SIGNERS() external view returns (uint8); // 3

    function usdg() external view returns (address);
    function attestor() external view returns (address);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address); // 0 when no transfer is pending
    function orry() external view returns (address); // 0 until executeCoin
    function buyback() external view returns (address); // 0 until executeCoin

    function ownerAccrued() external view returns (uint256);
    function buybackReserve() external view returns (uint256);
    function availableForBuyback() external view returns (uint256);
    function isQuoteSigner(address signer) external view returns (bool);
    function quoteUsed(bytes32 quoteId) external view returns (bool);

    /// @notice Anyone: splits USDG received since the last sync.
    function sync() external;
    function withdrawOwnerShare() external;
    function reclaimReserve() external;
    function proposeCoin(address orry, address buyback) external;
    function executeCoin() external;
    function pullBuyback(uint256 amount) external returns (uint256 pulled);

    /// @notice EIP-712 `CreditsQuote(address buyer,uint32 packs,uint256 orryAmount,bytes32 quoteId,uint64 expiry)`,
    /// domain {name "Orrery Treasury", version "1", chainId, verifyingContract}. Burns `orryAmount` from the caller
    /// (burnFrom) and emits `CreditsPaid`; the API grants the packs once per quoteId.
    function burnForCredits(uint32 packs, uint256 orryAmount, bytes32 quoteId, uint64 expiry, bytes calldata sig) external;

    /// @notice EIP-712 `VerificationQuote(address payer,uint256 agentId,uint256 orryAmount,bytes32 quoteId,uint64 expiry)`.
    /// Burns the ORRY, then calls `OrreryAttestor.payVerification(agentId, expectedOwner, fee)` as the treasury, which
    /// records the verification with fee 0 and moves no USDG.
    function verifyWithOrry(
        uint256 agentId,
        address expectedOwner,
        uint256 orryAmount,
        bytes32 quoteId,
        uint64 expiry,
        bytes calldata sig
    ) external;

    function setQuoteSigner(address signer, bool enabled) external;
    function transferOwnership(address newOwner) external; // two-step
    function acceptOwnership() external;
}
