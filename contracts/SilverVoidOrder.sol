// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SilverVoidOrder
 * @notice Soulbound rank badges — the proof of what a Seeker has burned.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Rank was only ever computed on the fly by the website from the burn
 * contract. Verifiable, but not an object: if the site disappears, so does the
 * proof. These badges make it permanent and readable by any tool, independent
 * of us — which is the whole premise of the project.
 *
 * It also settles a contradiction that had been live for months: the interface
 * announced rank NFTs as "Soulbound" while the contract allowed transfers and
 * the Store listed them. A badge that can be sold proves nothing. This one
 * cannot move, enforced by the contract rather than promised by the UI.
 *
 * ═══ WHAT IS AND ISN'T HERE ═══
 *
 * One family only: the four Order ranks, earned by burning zkLTC.
 *
 * No Arena badges. The duelist leaderboard and arena feats already answer
 * "what have you fought"; a second ladder of medals would leave players unsure
 * which one to read. The duel history is also split across contracts, so an
 * arena badge would inherit that gap. It can be added later in its own
 * contract without touching this one — and should only be added if the
 * leaderboard proves insufficient.
 *
 * ═══ SOURCE OF TRUTH ═══
 *
 * Eligibility is read live from the burn contract's own accounting, never
 * mirrored into a local counter. A mirror can drift; a read cannot. The burn
 * contract has never been redeployed, so lifetime totals are intact and every
 * past offering counts.
 *
 * ═══ CATCH-UP ═══
 *
 * Badges are claimable per rank, not just for the highest reached. Someone who
 * burned 100 zkLTC long before this contract existed claims all four. Anything
 * else would punish the earliest supporters, whose burns are already carved
 * into the chain.
 */

library Strings {
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

library Base64 {
    string internal constant TABLE =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

interface IBurnContract {
    /// @return amount lifetime zkLTC burned, rank index, rank name
    function getBurnerInfo(address user) external view returns (uint256, uint8, string memory);
}

contract SilverVoidOrder {

    using Strings for uint256;

    // ═══════════════════════════════════════════
    // CONFIG
    // ═══════════════════════════════════════════

    address public immutable BURN_CONTRACT;
    address public constant  FEE_RECIPIENT = 0x5489667F306a6F03F550FCB129F765f83FaCB24E;

    /// @notice Same gesture as the existing rank NFT claim. Not a sink — the
    ///         point is the act, not the amount.
    uint256 public constant CLAIM_COST = 0.01 ether;

    uint8 public constant RANK_COUNT = 4;

    string public name   = "The Silver Void - Order";
    string public symbol = "SVO";

    // ═══════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════

    uint256 private _nextTokenId = 1;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    /// @notice rank (1..4) => wallet => tokenId, 0 if unclaimed.
    mapping(uint8 => mapping(address => uint256)) public badgeOf;

    mapping(uint256 => uint8)   public tokenRank;
    mapping(uint256 => uint256) public tokenClaimedAt;
    /// @notice Lifetime burn at the moment of the claim. Frozen deliberately:
    ///         a badge should say what was true when it was earned, not track
    ///         a number that keeps moving.
    mapping(uint256 => uint256) public tokenBurnAtClaim;

    /// @notice How many wallets hold each rank — real scarcity, on-chain.
    mapping(uint8 => uint256) public mintedPerRank;

    uint256 public totalMinted;

    // ═══════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event BadgeClaimed(address indexed seeker, uint8 indexed rank, uint256 tokenId, uint256 burnedAtClaim);

    constructor(address burnContract) {
        BURN_CONTRACT = burnContract;
    }

    // ═══════════════════════════════════════════
    // ELIGIBILITY
    // ═══════════════════════════════════════════

    /// @notice Burn threshold for a rank, in wei. Mirrors the burn contract's
    ///         own ladder: 0.5 / 5 / 20 / 100 zkLTC.
    function thresholdFor(uint8 rank) public pure returns (uint256) {
        if (rank == 1) return 0.5 ether;
        if (rank == 2) return 5 ether;
        if (rank == 3) return 20 ether;
        if (rank == 4) return 100 ether;
        revert("SilverVoidOrder: rank out of range");
    }

    /// @notice Lifetime zkLTC burned by a wallet, read from the burn contract.
    function burnedBy(address seeker) public view returns (uint256) {
        try IBurnContract(BURN_CONTRACT).getBurnerInfo(seeker) returns (uint256 amount, uint8, string memory) {
            return amount;
        } catch {
            return 0;
        }
    }

    /// @notice True when the wallet has burned enough and hasn't claimed yet.
    function canClaim(address seeker, uint8 rank) public view returns (bool) {
        if (rank < 1 || rank > RANK_COUNT) return false;
        if (badgeOf[rank][seeker] != 0) return false;
        return burnedBy(seeker) >= thresholdFor(rank);
    }

    /// @notice Every rank this wallet is entitled to but hasn't claimed.
    ///         Lets the frontend offer "claim all" without probing one by one.
    function claimableRanks(address seeker) external view returns (uint8[] memory ranks) {
        uint256 burned = burnedBy(seeker);
        uint8 n = 0;
        for (uint8 r = 1; r <= RANK_COUNT; r++) {
            if (badgeOf[r][seeker] == 0 && burned >= thresholdFor(r)) n++;
        }
        ranks = new uint8[](n);
        uint8 k = 0;
        for (uint8 r = 1; r <= RANK_COUNT; r++) {
            if (badgeOf[r][seeker] == 0 && burned >= thresholdFor(r)) ranks[k++] = r;
        }
    }

    /// @notice Badges held, as a fixed-length flag array (index 0 = rank 1).
    function badgesOf(address seeker) external view returns (bool[4] memory held) {
        for (uint8 r = 1; r <= RANK_COUNT; r++) held[r - 1] = badgeOf[r][seeker] != 0;
    }

    // ═══════════════════════════════════════════
    // CLAIM
    // ═══════════════════════════════════════════

    /// @notice Claim the badge for one rank you've already earned.
    function claim(uint8 rank) external payable returns (uint256 tokenId) {
        require(msg.value == CLAIM_COST, "SilverVoidOrder: send exactly 0.01 zkLTC");
        tokenId = _mintBadge(msg.sender, rank);
        _forwardFee(msg.value);
    }

    /// @notice Claim every badge earned so far in one transaction — the
    ///         catch-up path for Seekers who burned long before this contract.
    function claimAll() external payable returns (uint256 minted) {
        uint256 burned = burnedBy(msg.sender);
        for (uint8 r = 1; r <= RANK_COUNT; r++) {
            if (badgeOf[r][msg.sender] == 0 && burned >= thresholdFor(r)) {
                _mintBadge(msg.sender, r);
                minted++;
            }
        }
        require(minted > 0, "SilverVoidOrder: nothing to claim");
        // One flat fee for the batch: catching up shouldn't cost more than
        // having claimed each rank as it was reached.
        require(msg.value == CLAIM_COST, "SilverVoidOrder: send exactly 0.01 zkLTC");
        _forwardFee(msg.value);
    }

    function _mintBadge(address to, uint8 rank) private returns (uint256 tokenId) {
        require(rank >= 1 && rank <= RANK_COUNT, "SilverVoidOrder: rank out of range");
        require(badgeOf[rank][to] == 0, "SilverVoidOrder: badge already claimed");
        uint256 burned = burnedBy(to);
        require(burned >= thresholdFor(rank), "SilverVoidOrder: rank not reached");

        tokenId = _nextTokenId++;
        _owners[tokenId] = to;
        _balances[to]++;
        badgeOf[rank][to]       = tokenId;
        tokenRank[tokenId]      = rank;
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
        require(sent, "SilverVoidOrder: fee transfer failed");
    }

    // ═══════════════════════════════════════════
    // SOULBOUND
    // ═══════════════════════════════════════════
    //
    // Enforced here, not in the interface. The previous rank NFTs were labelled
    // "Soulbound" on the site while remaining freely transferable — a badge you
    // can buy proves nothing about the person holding it.

    error Soulbound();

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
        require(owner != address(0), "ERC721: zero address");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "ERC721: nonexistent token");
        return owner;
    }

    function totalSupply() external view returns (uint256) { return totalMinted; }

    /// @notice Token ids held by a wallet — at most four, so no pagination.
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
        require(_owners[tokenId] != address(0), "SilverVoidOrder: nonexistent token");
        uint8 rank = tokenRank[tokenId];
        string memory json = string(abi.encodePacked(
            '{"name":"', _rankTitle(rank), ' - Order Badge",',
            '"description":"', _rankLore(rank), ' Soulbound: this badge cannot be sold, traded or transferred. It is a proof of sacrifice, and proofs do not change hands.",',
            '"image":"', _imageURI(rank), '",',
            '"attributes":[',
            '{"trait_type":"Path","value":"The Order"},',
            '{"trait_type":"Rank","value":', uint256(rank).toString(), '},',
            '{"trait_type":"Title","value":"', _rankTitle(rank), '"},',
            '{"trait_type":"Burned At Claim","value":"', _formatEther(tokenBurnAtClaim[tokenId]), ' zkLTC"},',
            '{"trait_type":"Holders","value":', mintedPerRank[rank].toString(), '},',
            '{"trait_type":"Soulbound","value":"Yes"},',
            '{"trait_type":"Network","value":"LitVM"}',
            ']}'
        ));
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    /// @notice Collection-level metadata, so badges appear grouped rather than
    ///         as loose tokens wherever they're displayed.
    function contractURI() external pure returns (string memory) {
        string memory json = '{"name":"The Silver Void - Order","description":"Soulbound rank badges from The Silver Void. Each one proves zkLTC burned and can never be transferred - a proof of sacrifice, not of wealth.","external_link":"https://thesilvervoid.com"}';
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
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

    /// @dev The four seals, on Arweave. Immutable by design: a badge minted
    ///      against one of these keeps it forever, so these IDs must be final
    ///      before the contract is deployed.
    function _imageURI(uint8 rank) private pure returns (string memory) {
        if (rank == 1) return "https://arweave.net/a9rZ7PaIJl3zOMifTHUnSiPwITncvsdAH72L9Evc4Ck";
        if (rank == 2) return "https://arweave.net/mZLhFfgk1Nyyr2ivWOWJWBkcexcNtLvjPg3G50hu34o";
        if (rank == 3) return "https://arweave.net/qxCCzciXnnjaOeUHDHFOF-HnwuKttUhFhwlxma4OTng";
        return "https://arweave.net/YDW62naXHXTLCNTc67Gnu1ao06zIzvltr3yqSCt6MSQ";
    }

    /// @dev Two decimals is enough for a label; the exact wei value stays
    ///      readable through tokenBurnAtClaim().
    function _formatEther(uint256 weiAmount) private pure returns (string memory) {
        uint256 whole = weiAmount / 1e18;
        uint256 frac  = (weiAmount % 1e18) / 1e16;
        if (frac == 0) return whole.toString();
        if (frac < 10) return string(abi.encodePacked(whole.toString(), ".0", frac.toString()));
        return string(abi.encodePacked(whole.toString(), ".", frac.toString()));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd   // ERC-721
            || interfaceId == 0x5b5e139f   // ERC-721Metadata
            || interfaceId == 0x01ffc9a7;  // ERC-165
    }

    receive() external payable { revert("SilverVoidOrder: use claim()"); }
    fallback() external payable { revert("SilverVoidOrder: use claim()"); }
}
