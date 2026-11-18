// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolMarketBase} from "../../markets/utils/PoolMarketBase.sol";
import {LimitOrderBook} from "../../../src/markets/r2/LimitOrderBook.sol";
import {ILimitOrderBook} from "../../../src/markets/r2/interfaces/ILimitOrderBook.sol";

/// @notice ERC-1271 smart account stand-in: one owner key signs for it; it can approve tokens.
contract Wallet1271 {
    address public immutable signer;
    bool public refuse;

    constructor(address signer_) {
        signer = signer_;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    function approve(address token, address spender) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok, "approve");
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (refuse || sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @notice The limit order book on the R1 pool world (`PoolMarketBase`, read only): TSLA-like stock with a plain v4
/// stock/USDG pool at the feed price (358.25 USD), listed through the R1 factory `pf`. Book values are the spec's guesses
/// (`docs/updates/L3-R2-SPEC.md` 4): fee 0.10%, band 1%, staleness 25 hours, ORRY fee discount 25%.
abstract contract LimitBase is PoolMarketBase {
    LimitOrderBook internal book;
    address internal maker;
    uint256 internal makerKey;
    address internal keeper = makeAddr("keeper");
    uint256 internal nextNonce = 1;

    function setUp() public virtual override {
        super.setUp();
        book = new LimitOrderBook(
            address(usdg), address(pf), pm, treasury, address(tiers), address(orryPrice), address(orry), 10, 100, 90_000, 2500
        );
        (maker, makerKey) = makeAddrAndKey("maker");
        stock.mint(maker, 1_000e18);
        usdg.mint(maker, 1_000_000e6);
        orry.transfer(maker, 10_000_000e18);
        vm.startPrank(maker);
        stock.approve(address(book), type(uint256).max);
        usdg.approve(address(book), type(uint256).max);
        orry.approve(address(book), type(uint256).max);
        vm.stopPrank();
    }

    function _order(bool sellAsset, uint256 amountIn, uint256 limit, uint16 tipBps)
        internal
        returns (ILimitOrderBook.Order memory o)
    {
        o = ILimitOrderBook.Order({
            owner: maker,
            asset: address(stock),
            sellAsset: sellAsset,
            amountIn: amountIn,
            limitPrice: limit,
            tipBps: tipBps,
            payFeeInOrry: false,
            nonce: nextNonce++,
            expiry: uint64(_now() + 1 days)
        });
    }

    function _sign(ILimitOrderBook.Order memory o, uint256 key_) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key_, book.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    function _fill(ILimitOrderBook.Order memory o) internal returns (uint256) {
        bytes memory sig = _sign(o, makerKey);
        vm.prank(keeper);
        return book.fill(o, sig);
    }
}
