// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SilverVoidSkins
 * @notice Ring skins of The Silver Void — bought on-chain, worn off-chain.
 *
 * ═══ WHAT THIS REPLACES ═══
 *
 * On testnet a skin was bought in two transactions (a burn at the Ritual, then
 * a transfer to the treasury), and the server had to find both, read them and
 * check the amounts before granting the skin. Heavy, and the kind of check a
 * bot could try to make the server repeat.
 *
 * Now one transaction does it all: the contract takes the exact price, burns
 * half through the Ritual for the buyer's rank, pays the other half to the
 * creator, and records the purchase. The server's whole check becomes one
 * read — owns(wallet, skin) — and since a skin can never be sold or lost, the
 * server can remember a "yes" forever and never ask the chain again.
 *
 * Wearing a skin stays off-chain (free, instant): only ownership lives here.
 *
 * ═══ THE CATALOGUE ═══
 *
 * Skins for sale are listed by their site key (e.g. "ring_moon") and a tier.
 * Prices are per tier, set at deployment. A curator may ADD skins later; a
 * skin's tier never changes, and curation can be handed over or renounced.
 * Skins earned through feats (never sold) are not listed here.
 */

interface IRitualK {
    function burnFor(address beneficiary, uint8 source) external payable;
    function MIN_BURN() external view returns (uint256);
}

contract SilverVoidSkins {

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint8   public constant SOURCE_SKIN = 4;
    uint256 public constant BURN_BPS = 5000;   // 50% burned for the buyer, 50% to the creator
    uint256 public constant MAX_SKINS = 128;

    IRitualK public immutable RITUAL;
    address  public immutable CREATOR;

    /// @notice Price per tier: 1 = Rare, 2 = Epic, 3 = Legendary.
    uint256 public immutable PRICE_TIER_1;
    uint256 public immutable PRICE_TIER_2;
    uint256 public immutable PRICE_TIER_3;

    struct Skin { string key; uint8 tier; }
    Skin[] private _skins;                          // skin id = index + 1
    mapping(bytes32 => uint16) private _idOfKey;    // keccak(key) => id

    /// @notice wallet => skin id => owned
    mapping(address => mapping(uint16 => bool)) public ownsId;
    mapping(uint16 => uint256) public soldPerSkin;

    address public curator;
    address public pendingCurator;

    uint256 public totalSold;
    uint256 public totalBurned;
    mapping(address => uint256) public pendingWithdrawals;

    event SkinAdded(uint16 indexed skinId, string key, uint8 tier);
    event SkinBought(address indexed buyer, uint16 indexed skinId, string key, uint256 price);
    event CurationTransferStarted(address indexed from, address indexed to);
    event CurationTransferred(address indexed from, address indexed to);
    event CurationRenounced(address indexed by);
    event PaymentDeferred(address indexed recipient, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    error BadConfig();
    error NotCurator();
    error NotPendingCurator();
    error CurationClosed();
    error BadSkin();
    error SkinExists();
    error CatalogueFull();
    error UnknownSkin();
    error AlreadyOwned();
    error WrongPrice(uint256 sent, uint256 expected);
    error ZeroAddress();
    error NothingToWithdraw();
    error WithdrawFailed();
    error UseBuy();

    /**
     * @param ritual   The Ritual (burnFor).
     * @param creator  Receives half of each sale. Ledger or multisig on mainnet.
     * @param curator_ May add skins later.
     * @param prices   Price per tier: [Rare, Epic, Legendary], never decreasing.
     */
    constructor(address ritual, address creator, address curator_, uint256[3] memory prices) {
        if (ritual == address(0) || creator == address(0) || curator_ == address(0)) revert BadConfig();
        if (prices[0] == 0 || prices[1] < prices[0] || prices[2] < prices[1]) revert BadConfig();
        RITUAL = IRitualK(ritual);
        CREATOR = creator;
        curator = curator_;
        PRICE_TIER_1 = prices[0];
        PRICE_TIER_2 = prices[1];
        PRICE_TIER_3 = prices[2];

        // Les skins vendus aujourd'hui sur le site, avec leur palier.
        _add("ring_block", 1);   _add("ring_moon", 1);    _add("ring_halving", 1);
        _add("ring_eclipse", 2); _add("ring_bolt", 2);    _add("ring_mimble", 2);
        _add("ring_trinity", 3); _add("ring_ember", 3);   _add("ring_shadow", 3); _add("ring_84m", 3);
    }

    // ═══════════════════════════════════════════
    // CATALOGUE
    // ═══════════════════════════════════════════

    modifier onlyCurator() {
        if (curator == address(0)) revert CurationClosed();
        if (msg.sender != curator) revert NotCurator();
        _;
    }

    function addSkin(string calldata key, uint8 tier) external onlyCurator returns (uint16) { return _add(key, tier); }

    function _add(string memory key, uint8 tier) private returns (uint16 id) {
        bytes memory b = bytes(key);
        if (b.length == 0 || b.length > 64 || tier < 1 || tier > 3) revert BadSkin();
        bytes32 h = keccak256(b);
        if (_idOfKey[h] != 0) revert SkinExists();
        if (_skins.length >= MAX_SKINS) revert CatalogueFull();
        _skins.push(Skin(key, tier));
        id = uint16(_skins.length);
        _idOfKey[h] = id;
        emit SkinAdded(id, key, tier);
    }

    function transferCuration(address to) external onlyCurator {
        if (to == address(0)) revert ZeroAddress();
        pendingCurator = to;
        emit CurationTransferStarted(curator, to);
    }

    function acceptCuration() external {
        if (curator == address(0)) revert CurationClosed();
        if (msg.sender != pendingCurator) revert NotPendingCurator();
        emit CurationTransferred(curator, msg.sender);
        curator = msg.sender;
        pendingCurator = address(0);
    }

    function renounceCuration() external onlyCurator {
        emit CurationRenounced(msg.sender);
        curator = address(0);
        pendingCurator = address(0);
    }

    // ═══════════════════════════════════════════
    // BUY
    // ═══════════════════════════════════════════

    function priceForTier(uint8 tier) public view returns (uint256) {
        if (tier == 1) return PRICE_TIER_1;
        if (tier == 2) return PRICE_TIER_2;
        if (tier == 3) return PRICE_TIER_3;
        revert BadSkin();
    }

    function priceOf(string calldata key) external view returns (uint256) {
        uint16 id = _idOfKey[keccak256(bytes(key))];
        if (id == 0) revert UnknownSkin();
        return priceForTier(_skins[id - 1].tier);
    }

    /// @notice Buy a skin by its site key. Exact price only. Half is burned
    ///         for your rank, half goes to the creator. Yours forever.
    function buy(string calldata key) external payable {
        uint16 id = _idOfKey[keccak256(bytes(key))];
        if (id == 0) revert UnknownSkin();
        if (ownsId[msg.sender][id]) revert AlreadyOwned();
        uint256 price = priceForTier(_skins[id - 1].tier);
        if (msg.value != price) revert WrongPrice(msg.value, price);

        ownsId[msg.sender][id] = true;
        soldPerSkin[id]++;
        totalSold++;

        uint256 burnPart = (price * BURN_BPS) / 10000;
        uint256 creatorPart = price - burnPart;
        totalBurned += burnPart;
        if (burnPart >= RITUAL.MIN_BURN()) {
            RITUAL.burnFor{value: burnPart}(msg.sender, SOURCE_SKIN);
        } else {
            (bool sent, ) = DEAD_ADDRESS.call{value: burnPart}("");
            if (!sent) _payOrDefer(CREATOR, burnPart);
        }
        _payOrDefer(CREATOR, creatorPart);

        emit SkinBought(msg.sender, id, _skins[id - 1].key, price);
    }

    function _payOrDefer(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool sent, ) = recipient.call{value: amount, gas: 30000}("");
        if (!sent) {
            pendingWithdrawals[recipient] += amount;
            emit PaymentDeferred(recipient, amount);
        }
    }

    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        if (!sent) revert WithdrawFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════
    // READS — what the server checks
    // ═══════════════════════════════════════════

    /// @notice The one check the server needs: does this wallet own this skin?
    function owns(address wallet, string calldata key) external view returns (bool) {
        uint16 id = _idOfKey[keccak256(bytes(key))];
        return id != 0 && ownsId[wallet][id];
    }

    /// @notice Every skin key this wallet owns.
    function skinsOf(address wallet) external view returns (string[] memory keys) {
        uint256 total = _skins.length;
        uint256 n = 0;
        for (uint256 i = 0; i < total; i++) if (ownsId[wallet][uint16(i + 1)]) n++;
        keys = new string[](n);
        uint256 k = 0;
        for (uint256 i = 0; i < total; i++) if (ownsId[wallet][uint16(i + 1)]) keys[k++] = _skins[i].key;
    }

    function skinCount() external view returns (uint16) { return uint16(_skins.length); }

    function skinInfo(uint16 id) external view returns (string memory key, uint8 tier, uint256 price, uint256 sold) {
        if (id == 0 || id > _skins.length) revert UnknownSkin();
        Skin storage s = _skins[id - 1];
        return (s.key, s.tier, priceForTier(s.tier), soldPerSkin[id]);
    }

    receive() external payable { revert UseBuy(); }
    fallback() external payable { revert UseBuy(); }
}
