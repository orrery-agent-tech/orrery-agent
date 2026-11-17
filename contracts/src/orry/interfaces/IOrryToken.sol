// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The ORRY token as launched on Pons V2 (fixed 1,000,000,000 supply, 18 decimals, no mint, no owner).
/// `burn` and `burnFrom` were found in the bytecode of a live Pons V2 token on 4663 (2026-11-08); the build must
/// confirm both on the real ORRY before deployment. Frozen in `docs/ORRY-BUILD-SPEC.md` section 2.
interface IOrryToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}

/// @notice One event for every ORRY burn in Orrery, so the burn page and the indexer read a single shape.
/// Sources: 1 rewards router (ORRY half), 2 check packs paid in ORRY, 3 verification paid in ORRY,
/// 4 buyback of the rewards router's ETH half.
interface IOrryBurnEvents {
    event Burned(uint8 indexed source, uint256 amount);
}
