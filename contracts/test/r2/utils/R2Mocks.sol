// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice An ORRY stand-in whose burns take the full amount from the balance but lower the total supply by one less:
/// the shape of a token that does not burn what it says. The R2 contracts check every burn on the total supply.
contract ShortBurnOrry {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address holder, uint256 supply) {
        totalSupply = supply;
        balanceOf[holder] = supply;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address account, uint256 amount) external {
        allowance[account][msg.sender] -= amount;
        _burn(account, amount);
    }

    function _burn(address account, uint256 amount) internal {
        balanceOf[account] -= amount;
        totalSupply -= amount - 1;
    }
}

/// @notice A Chainlink stand-in that answers every round id, round 0 included, with the same time and answer.
contract AnyRoundFeed {
    uint8 public constant decimals = 8;
    int256 public answer;
    uint256 public updatedAt;

    function set(int256 a, uint256 t) external {
        (answer, updatedAt) = (a, t);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (5, answer, updatedAt, updatedAt, 5);
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (id, answer, updatedAt, updatedAt, id);
    }
}

/// @notice Fee tiers stand-in: a settable discount per account, or a revert for every read.
contract MockFeeTiers {
    mapping(address => uint16) public discount;
    bool public reverts;

    function set(address account, uint16 d) external {
        discount[account] = d;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function discountBps(address account) external view returns (uint16) {
        require(!reverts, "tiers down");
        return discount[account];
    }
}

/// @notice A verifier that answers false instead of reverting (the generated one reverts on most bad proofs).
contract FalseVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return false;
    }
}
