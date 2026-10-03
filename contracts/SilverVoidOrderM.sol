// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SilverVoidOrder
 * @notice Soulbound rank badges — the permanent proof of what a Seeker has
 *         burned — mainnet revision.
 *
 * ═══ WHAT CHANGED FROM THE TESTNET CONTRACT, AND WHY ═══
 *
 * 1. THE RANK IS READ FROM THE RITUAL. The testnet contract copied the
 *    thresholds (0.5 / 5 / 20 / 100). The mainnet ladder differs, and a copy
 *    can drift: getRank() on the Ritual is now the only source. A badge for
 *    rank N can be claimed by any wallet whose Ritual rank is N or more.
 *
 * 2. THE CLAIM FEE AND ITS RECIPIENT ARE SET AT DEPLOYMENT, so the fee can
 *    follow the real price of LTC and the recipient can be a hardware wallet
 *    or a multisig.
 *
 * ═══ KEPT ═══
 *
 *   Soulbound — enforced by the contract, not promised by the interface.
 *   Catch-up: claimAll() mints every rank already earned, for one flat fee.
 *   The burn total at the moment of the claim is frozen into the badge.
 *   Fully on-chain metadata, the four seals on Arweave.
 */

library StringsO {
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) { digits--; buffer[digits] = bytes1(uint8(48 + uint256(value % 10))); value /= 10; }
        return string(buffer);
    }
}

library Base64O {
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        string memory table = TABLE;
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        string memory result = new string(encodedLen + 32);
        assembly {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 32)
            for { let i := 0 } lt(i, mload(data)) { } {
                i := add(i, 3)
                let input := and(mload(add(data, i)), 0xffffff)
                let out := mload(add(tablePtr, and(shr(18, input), 0x3F)))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(12, input), 0x3F))), 255))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(6, input), 0x3F))), 255))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(input, 0x3F))), 255))
                out := shl(224, out)
                mstore(resultPtr, out)
                resultPtr := add(resultPtr, 4)
            }
            switch mod(mload(data), 3)
            case 1 { mstore(sub(resultPtr, 2), shl(240, 0x3d3d)) }
            case 2 { mstore(sub(resultPtr, 1), shl(248, 0x3d)) }
            mstore(result, encodedLen)
        }
        return result;
    }
}

interface IRitualO {
    function getRank(address user) external view returns (uint8);
    function burnedAmount(address user) external view returns (uint256);
}

contract SilverVoidOrder {

    using StringsO for uint256;

    uint8 public constant RANK_COUNT = 4;

    IRitualO public immutable RITUAL;
    address  public immutable FEE_RECIPIENT;
    uint256  public immutable CLAIM_COST;

    string public name   = "The Silver Void - Order";
    string public symbol = "SVO";

    uint256 private _nextTokenId = 1;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    /// @notice rank (1..4) => wallet => tokenId, 0 if unclaimed.
    mapping(uint8 => mapping(address => uint256)) public badgeOf;
    mapping(uint256 => uint8)   public tokenRank;
    mapping(uint256 => uint256) public tokenClaimedAt;
    /// @notice Lifetime burn at the moment of the claim, frozen into the badge.
    mapping(uint256 => uint256) public tokenBurnAtClaim;
    mapping(uint8 => uint256)   public mintedPerRank;
    uint256 public totalMinted;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event BadgeClaimed(address indexed seeker, uint8 indexed rank, uint256 tokenId, uint256 burnedAtClaim);

    error BadConfig();
    error RankOutOfRange();
    error AlreadyClaimed();
    error RankNotReached();
    error NothingToClaim();
    error BadFee(uint256 sent, uint256 expected);
    error FeeTransferFailed();
    error NoToken();
    error ZeroAddress();
    error Soulbound();
    error UseClaim();

    /**
     * @param ritual        The Ritual (ranks and burn totals).
     * @param feeRecipient  Receives the claim fee. Ledger or multisig on mainnet.
     * @param claimCost     Fee per claim (and for one claimAll).
     */
    constructor(address ritual, address feeRecipient, uint256 claimCost) {
        if (ritual == address(0) || feeRecipient == address(0)) revert BadConfig();
        RITUAL = IRitualO(ritual);
        FEE_RECIPIENT = feeRecipient;
        CLAIM_COST = claimCost;
    }

    // ═══════════════════════════════════════════
    // ELIGIBILITY — read from the Ritual
    // ═══════════════════════════════════════════

    function rankOf(address seeker) public view returns (uint8) {
        try RITUAL.getRank(seeker) returns (uint8 r) { return r; } catch { return 0; }
    }

    function burnedBy(address seeker) public view returns (uint256) {
        try RITUAL.burnedAmount(seeker) returns (uint256 a) { return a; } catch { return 0; }
    }

    function canClaim(address seeker, uint8 rank) public view returns (bool) {
        if (rank < 1 || rank > RANK_COUNT) return false;
        if (badgeOf[rank][seeker] != 0) return false;
        return rankOf(seeker) >= rank;
    }

    function claimableRanks(address seeker) external view returns (uint8[] memory ranks) {
        uint8 current = rankOf(seeker);
        uint8 n = 0;
        for (uint8 r = 1; r <= RANK_COUNT; r++) if (badgeOf[r][seeker] == 0 && current >= r) n++;
        ranks = new uint8[](n);
        uint8 k = 0;
        for (uint8 r = 1; r <= RANK_COUNT; r++) if (badgeOf[r][seeker] == 0 && current >= r) ranks[k++] = r;
    }

    function badgesOf(address seeker) external view returns (bool[4] memory held) {
        for (uint8 r = 1; r <= RANK_COUNT; r++) held[r - 1] = badgeOf[r][seeker] != 0;
    }

    // ═══════════════════════════════════════════
    // CLAIM
    // ═══════════════════════════════════════════

    function claim(uint8 rank) external payable returns (uint256 tokenId) {
        if (msg.value != CLAIM_COST) revert BadFee(msg.value, CLAIM_COST);
        tokenId = _mintBadge(msg.sender, rank);
        _forwardFee(msg.value);
    }

    /// @notice Claim every badge earned so far, for one flat fee.
    function claimAll() external payable returns (uint256 minted) {
        if (msg.value != CLAIM_COST) revert BadFee(msg.value, CLAIM_COST);
        uint8 current = rankOf(msg.sender);
        for (uint8 r = 1; r <= RANK_COUNT; r++) {
            if (badgeOf[r][msg.sender] == 0 && current >= r) { _mintBadge(msg.sender, r); minted++; }
        }
        if (minted == 0) revert NothingToClaim();
        _forwardFee(msg.value);
    }

    function _mintBadge(address to, uint8 rank) private returns (uint256 tokenId) {
        if (rank < 1 || rank > RANK_COUNT) revert RankOutOfRange();
        if (badgeOf[rank][to] != 0) revert AlreadyClaimed();
        if (rankOf(to) < rank) revert RankNotReached();

        uint256 burned = burnedBy(to);
        tokenId = _nextTokenId++;
        _owners[tokenId] = to;
        _balances[to]++;
        badgeOf[rank][to] = tokenId;
        tokenRank[tokenId] = rank;
        tokenClaimedAt[tokenId] = block.timestamp;
        tokenBurnAtClaim[tokenId] = burned;
        mintedPerRank[rank]++;
        totalMinted++;

        emit Transfer(address(0), to, tokenId);
        emit BadgeClaimed(to, rank, tokenId, burned);
    }

    function _forwardFee(uint256 amount) private {
        if (amount == 0) return;
        (bool sent, ) = FEE_RECIPIENT.call{value: amount}("");
        if (!sent) revert FeeTransferFailed();
    }

    // ═══════════════════════════════════════════
    // SOULBOUND
    // ═══════════════════════════════════════════

    function transferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert Soulbound(); }
    function approve(address, uint256) external pure { revert Soulbound(); }
    function setApprovalForAll(address, bool) external pure { revert Soulbound(); }
    function getApproved(uint256) external pure returns (address) { return address(0); }
    function isApprovedForAll(address, address) external pure returns (bool) { return false; }

    // ═══════════════════════════════════════════
    // ERC-721 READS
    // ═══════════════════════════════════════════

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert NoToken();
        return owner;
    }

    function totalSupply() external view returns (uint256) { return totalMinted; }

    function tokensOfOwner(address seeker) external view returns (uint256[] memory ids) {
        uint256 n = _balances[seeker];
        ids = new uint256[](n);
        uint256 k = 0;
        for (uint8 r = 1; r <= RANK_COUNT && k < n; r++) {
            uint256 id = badgeOf[r][seeker];
            if (id != 0) ids[k++] = id;
        }
    }

    // ═══════════════════════════════════════════
    // METADATA
    // ═══════════════════════════════════════════

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert NoToken();
        uint8 rank = tokenRank[tokenId];
        string memory json = string.concat(
            '{"name":"', _rankTitle(rank), ' - Order Badge",',
            '"description":"', _rankLore(rank), ' Soulbound: this badge cannot be sold, traded or transferred. It is a proof of sacrifice, and proofs do not change hands.",',
            '"image":"', _imageURI(rank), '",',
            '"attributes":[{"trait_type":"Path","value":"The Order"},',
            '{"trait_type":"Rank","value":', uint256(rank).toString(), '},',
            '{"trait_type":"Title","value":"', _rankTitle(rank), '"},',
            '{"trait_type":"Burned At Claim","value":"', _formatEther(tokenBurnAtClaim[tokenId]), ' zkLTC"},',
            '{"trait_type":"Holders","value":', mintedPerRank[rank].toString(), '},',
            '{"trait_type":"Soulbound","value":"Yes"},{"trait_type":"Network","value":"LitVM"}]}'
        );
        return string.concat("data:application/json;base64,", Base64O.encode(bytes(json)));
    }

    function contractURI() external pure returns (string memory) {
        string memory json = '{"name":"The Silver Void - Order","description":"Soulbound rank badges from The Silver Void. Each one proves zkLTC burned and can never be transferred - a proof of sacrifice, not of wealth.","external_link":"https://thesilvervoid.com"}';
        return string.concat("data:application/json;base64,", Base64O.encode(bytes(json)));
    }

    function _rankTitle(uint8 rank) private pure returns (string memory) {
        if (rank == 1) return "Simple Holder";
        if (rank == 2) return "Apprentice Litecoiner";
        if (rank == 3) return "Devoted Litecoiner";
        if (rank == 4) return "Silver Maximalist";
        return "Unranked";
    }

    function _rankLore(uint8 rank) private pure returns (string memory) {
        if (rank == 1) return "You hold Litecoin. The original silver to Bitcoin's gold. Your journey into the Void begins here.";
        if (rank == 2) return "Litecoin has survived every bear market, every obituary. You burn to prove your conviction runs deeper than price.";
        if (rank == 3) return "MimbleWimble. Lightning Network. Decades of relentless development. You are the infrastructure behind the revolution.";
        if (rank == 4) return "84 million coins. The fastest settlement layer. The most battle-tested chain after Bitcoin. You are its eternal guardian.";
        return "";
    }

    function _imageURI(uint8 rank) private pure returns (string memory) {
        if (rank == 1) return "https://arweave.net/a9rZ7PaIJl3zOMifTHUnSiPwITncvsdAH72L9Evc4Ck";
        if (rank == 2) return "https://arweave.net/mZLhFfgk1Nyyr2ivWOWJWBkcexcNtLvjPg3G50hu34o";
        if (rank == 3) return "https://arweave.net/qxCCzciXnnjaOeUHDHFOF-HnwuKttUhFhwlxma4OTng";
        return "https://arweave.net/YDW62naXHXTLCNTc67Gnu1ao06zIzvltr3yqSCt6MSQ";
    }

    function _formatEther(uint256 weiAmount) private pure returns (string memory) {
        uint256 whole = weiAmount / 1e18;
        uint256 frac  = (weiAmount % 1e18) / 1e16;
        if (frac == 0) return whole.toString();
        if (frac < 10) return string.concat(whole.toString(), ".0", frac.toString());
        return string.concat(whole.toString(), ".", frac.toString());
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f || interfaceId == 0x01ffc9a7;
    }

    receive() external payable { revert UseClaim(); }
    fallback() external payable { revert UseClaim(); }
}
