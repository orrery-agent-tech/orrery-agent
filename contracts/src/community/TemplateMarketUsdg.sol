// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IUsdgMin {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title TemplateMarketUsdg
/// @notice Policy template market paid in USDG (`docs/updates/TEMPLATES-USDG-SPEC.md`, invariants TU-I1 to TU-I9). A
/// creator lists a template (content hash and URI of a `OrreryPolicyModule` policy config) at a USDG price; a buyer pays
/// it, `feeBps` of it goes to the Orrery treasury and the rest to the creator, both straight from the buyer, and the
/// buyer holds a licence for good. The creator reprices, delists and relists; licences already sold stay.
/// @dev The listing surface (functions and the `TemplateListed`, `TemplatePriced`, `TemplateListing` events) is the one
/// of `TemplateMarket`. No owner, no setter, no custody: the market never holds USDG.
contract TemplateMarketUsdg {
    struct Template {
        address creator;
        bool listed;
        uint128 priceUsd;
        bytes32 contentHash;
    }

    event TemplateListed(uint256 indexed id, address indexed creator, uint256 priceUsd, bytes32 contentHash, string uri);
    event TemplatePriced(uint256 indexed id, uint256 priceUsd);
    event TemplateListing(uint256 indexed id, bool listed);
    event TemplateSold(uint256 indexed id, address indexed buyer, address indexed creator, uint256 price, uint256 fee);

    error ZeroAddress();
    error BadPrice();
    error EmptyHash();
    error BadUri();
    error UnknownTemplate();
    error NotCreator();
    error NotListed();
    error AlreadyLicensed();
    error OwnTemplate();
    error PriceAboveMax(uint256 price, uint256 maxPay);
    error InexactTransfer();

    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_URI_BYTES = 512;

    address public immutable usdg;
    address public immutable treasury;
    uint16 public immutable feeBps;
    uint256 public immutable minPriceUsd;
    uint256 public immutable maxPriceUsd;

    uint256 public templateCount;
    mapping(uint256 id => Template) private _templates;
    mapping(uint256 id => mapping(address buyer => bool)) public licensed;

    constructor(address usdg_, address treasury_, uint16 feeBps_, uint256 minPriceUsd_, uint256 maxPriceUsd_) {
        if (usdg_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        require(feeBps_ <= BPS, "fee bps");
        require(minPriceUsd_ != 0 && minPriceUsd_ <= maxPriceUsd_ && maxPriceUsd_ <= type(uint128).max, "bounds");
        usdg = usdg_;
        treasury = treasury_;
        feeBps = feeBps_;
        minPriceUsd = minPriceUsd_;
        maxPriceUsd = maxPriceUsd_;
    }

    function templateOf(uint256 id) external view returns (Template memory) {
        return _templates[id];
    }

    function list(uint256 priceUsd, bytes32 contentHash, string calldata uri) external returns (uint256 id) {
        _checkPrice(priceUsd);
        if (contentHash == bytes32(0)) revert EmptyHash();
        if (bytes(uri).length == 0 || bytes(uri).length > MAX_URI_BYTES) revert BadUri();
        id = ++templateCount;
        _templates[id] = Template(msg.sender, true, uint128(priceUsd), contentHash);
        emit TemplateListed(id, msg.sender, priceUsd, contentHash, uri);
    }

    function setPrice(uint256 id, uint256 priceUsd) external {
        Template storage t = _own(id);
        _checkPrice(priceUsd);
        t.priceUsd = uint128(priceUsd);
        emit TemplatePriced(id, priceUsd);
    }

    function setListed(uint256 id, bool listed) external {
        Template storage t = _own(id);
        t.listed = listed;
        emit TemplateListing(id, listed);
    }

    /// @notice What a licence costs now, in USDG base units.
    function quote(uint256 id) external view returns (uint256) {
        Template storage t = _templates[id];
        if (t.creator == address(0)) revert UnknownTemplate();
        return t.priceUsd;
    }

    /// @notice The fee and the creator's part of `price`.
    function split(uint256 price) public view returns (uint256 fee, uint256 toCreator) {
        fee = price * feeBps / BPS;
        toCreator = price - fee;
    }

    function buy(uint256 id, uint256 maxPay) external returns (uint256 paid) {
        Template storage t = _templates[id];
        address creator = t.creator;
        if (creator == address(0)) revert UnknownTemplate();
        if (!t.listed) revert NotListed();
        if (creator == msg.sender) revert OwnTemplate();
        if (licensed[id][msg.sender]) revert AlreadyLicensed();
        paid = t.priceUsd;
        if (paid > maxPay) revert PriceAboveMax(paid, maxPay);
        licensed[id][msg.sender] = true;
        (uint256 fee, uint256 toCreator) = split(paid);
        _pull(msg.sender, treasury, fee);
        _pull(msg.sender, creator, toCreator);
        emit TemplateSold(id, msg.sender, creator, paid, fee);
    }

    function _own(uint256 id) private view returns (Template storage t) {
        t = _templates[id];
        if (t.creator == address(0)) revert UnknownTemplate();
        if (t.creator != msg.sender) revert NotCreator();
    }

    function _checkPrice(uint256 priceUsd) private view {
        if (priceUsd < minPriceUsd || priceUsd > maxPriceUsd) revert BadPrice();
    }

    /// @dev Moves exactly `amount` USDG from `from` to `to`: a falsy return or a short balance delta on `to` reverts.
    function _pull(address from, address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = IUsdgMin(usdg).balanceOf(to);
        (bool ok, bytes memory ret) = usdg.call(abi.encodeCall(IUsdgMin.transferFrom, (from, to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert InexactTransfer();
        if (IUsdgMin(usdg).balanceOf(to) - before != amount) revert InexactTransfer();
    }
}
