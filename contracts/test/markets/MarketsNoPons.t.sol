// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MarketBase} from "./utils/MarketBase.sol";

/// @notice DP-10 (G-1, G-2) on the deployed runtime code of the four market contracts: no Pons address is embedded, no
/// Pons fee selector and no mint selector is pushed. The source grep is `test/markets/check_no_pons.py`. Scan helpers
/// copied from `test/orry/stake/NoPons.t.sol` (lane B).
contract MarketsNoPonsTest is MarketBase {
    address internal constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant PONS_FEE_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant PONS_MEME_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function _contracts() internal view returns (address[4] memory) {
        return [address(market), address(factory), address(tiers), address(orryPrice)];
    }

    function test_G1_no_pons_address_in_runtime_code() public view {
        address[3] memory pons = [PONS_FACTORY, PONS_FEE_ESCROW, PONS_MEME_HOOK];
        address[4] memory cs = _contracts();
        for (uint256 i; i < cs.length; ++i) {
            assertGt(cs[i].code.length, 0);
            for (uint256 j; j < pons.length; ++j) {
                assertFalse(_containsConst(cs[i].code, uint160(pons[j])), "Pons address embedded");
            }
        }
    }

    function test_G1_G2_no_pons_fee_or_mint_selectors() public view {
        bytes4[9] memory sels = [
            bytes4(keccak256("claim()")),
            bytes4(keccak256("claimToken(address)")),
            bytes4(keccak256("credit(address)")),
            bytes4(keccak256("sweepPoolFees(bytes32,uint256,uint256)")),
            bytes4(keccak256("setCreatorFeeRecipient(address,address)")),
            bytes4(keccak256("transferCreatorFeeRecipient(address,address)")),
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("mint(uint256)")),
            bytes4(keccak256("mint(address,uint256,uint256)"))
        ];
        address[4] memory cs = _contracts();
        for (uint256 i; i < cs.length; ++i) {
            for (uint256 j; j < sels.length; ++j) {
                assertFalse(_containsConst(cs[i].code, uint32(sels[j])), "Pons or mint selector in code");
            }
        }
    }

    /// @dev Positive control: the scan finds what is there (the market burns with burnFrom and reads rounds).
    function test_scan_finds_a_known_selector() public view {
        assertTrue(_containsConst(address(market).code, uint32(bytes4(keccak256("burnFrom(address,uint256)")))));
        assertTrue(_containsConst(address(market).code, uint32(bytes4(keccak256("getRoundData(uint80)")))));
    }

    /// @dev True when `value` appears in `code` as a constant in any form the optimizer may emit: its bytes as they are,
    /// or shifted right by any of its trailing zero bits (the optimizer pushes `v >> k` and shifts it back with SHL).
    function _containsConst(bytes memory code, uint256 value) internal pure returns (bool) {
        for (uint256 k; k < 256; ++k) {
            if (k != 0 && (value >> (k - 1)) & 1 != 0) break; // stop once a set bit would be shifted out
            uint256 v = value >> k;
            if (v == 0) break;
            uint256 len = 0;
            for (uint256 t = v; t != 0; t >>= 8) ++len;
            bytes memory needle = new bytes(len);
            for (uint256 b; b < len; ++b) needle[len - 1 - b] = bytes1(uint8(v >> (8 * b)));
            if (_contains(code, needle)) return true;
        }
        return false;
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i; i <= hay.length - needle.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}
