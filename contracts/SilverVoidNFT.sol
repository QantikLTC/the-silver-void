// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SilverVoidNFT
 * @notice Rank NFTs for the Silver Void protocol — LiteForge Testnet
 * @dev One NFT per (rank, nftId) per wallet.
 *      Transferable. 5% royalties via EIP-2981.
 *      0.01 zkLTC mint fee sent to protocol owner.
 */

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

interface ISilverVoid {
    function getRank(address user) external view returns (uint8);
    function burnedAmount(address user) external view returns (uint256);
}

contract SilverVoidNFT {

    using Strings for uint256;

    // ═══════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════

    address public immutable SILVER_VOID;

    /// @notice Protocol fee recipient & royalty receiver
    address public constant FEE_RECIPIENT = 0x5489667F306a6F03F550FCB129F765f83FaCB24E;

    /// @notice Mint fee: 0.01 zkLTC
    uint256 public constant MINT_FEE = 0.01 ether;

    /// @notice Royalty: 2.5% (EIP-2981, 250 basis points)
    uint96 public constant ROYALTY_BPS = 250;

    uint8 public constant MIN_RANK = 1;
    uint8 public constant MAX_RANK = 4;

    // ═══════════════════════════════════════════
    // ERC-721 STORAGE
    // ═══════════════════════════════════════════

    string public name   = "Silver Void Order";
    string public symbol = "SVO";

    uint256 private _nextTokenId = 1;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ═══════════════════════════════════════════
    // NFT-SPECIFIC STORAGE
    // ═══════════════════════════════════════════

    /// @notice wallet => rankId => nftId => tokenId (0 = not minted)
    mapping(address => mapping(uint8 => mapping(uint8 => uint256))) public mintedNFT;

    /// @notice tokenId => rank at mint
    mapping(uint256 => uint8) public tokenRank;

    /// @notice tokenId => nftId at mint
    mapping(uint256 => uint8) public tokenNFTId;

    /// @notice tokenId => original minter
    mapping(uint256 => address) public tokenMinter;

    // ═══════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event RankNFTMinted(address indexed minter, uint8 rank, uint8 nftId, uint256 tokenId);

    // ═══════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════

    constructor(address silverVoidAddress) {
        SILVER_VOID = silverVoidAddress;
    }

    // ═══════════════════════════════════════════
    // MINT
    // ═══════════════════════════════════════════

    /**
     * @notice Claim a specific NFT for your rank.
     * @param rankId  The rank (1=Simple Holder ... 4=Silver Maximalist)
     * @param nftId   The NFT variant (0=Common, 1=Rare, 2=Epic)
     */
    function mint(uint8 rankId, uint8 nftId) external payable {
        require(msg.value >= MINT_FEE, "SilverVoidNFT: insufficient mint fee (0.01 zkLTC)");
        require(rankId >= MIN_RANK && rankId <= MAX_RANK, "SilverVoidNFT: invalid rank");
        require(nftId <= _maxNFTId(rankId), "SilverVoidNFT: invalid nft id for this rank");
        require(mintedNFT[msg.sender][rankId][nftId] == 0, "SilverVoidNFT: already claimed");

        uint8 currentRank = ISilverVoid(SILVER_VOID).getRank(msg.sender);
        require(currentRank >= rankId, "SilverVoidNFT: rank not yet achieved");

        // Send fee to owner
        (bool sent, ) = FEE_RECIPIENT.call{value: msg.value}("");
        require(sent, "SilverVoidNFT: fee transfer failed");

        uint256 tokenId = _nextTokenId++;
        _owners[tokenId]                         = msg.sender;
        _balances[msg.sender]++;
        mintedNFT[msg.sender][rankId][nftId]     = tokenId;
        tokenRank[tokenId]                       = rankId;
        tokenNFTId[tokenId]                      = nftId;
        tokenMinter[tokenId]                     = msg.sender;

        emit Transfer(address(0), msg.sender, tokenId);
        emit RankNFTMinted(msg.sender, rankId, nftId, tokenId);
    }

    // ═══════════════════════════════════════════
    // EIP-2981 ROYALTIES
    // ═══════════════════════════════════════════

    /**
     * @notice Returns royalty info for marketplaces (EIP-2981)
     * @param salePrice The sale price of the token
     * @return receiver  The royalty recipient
     * @return royaltyAmount  The royalty amount (5% of sale price)
     */
    function royaltyInfo(uint256, uint256 salePrice) external pure returns (address receiver, uint256 royaltyAmount) {
        return (FEE_RECIPIENT, (salePrice * ROYALTY_BPS) / 10000);
    }

    // ═══════════════════════════════════════════
    // METADATA — FULLY ON-CHAIN
    // ═══════════════════════════════════════════

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_owners[tokenId] != address(0), "SilverVoidNFT: nonexistent token");
        uint8 rank  = tokenRank[tokenId];
        uint8 nftId = tokenNFTId[tokenId];
        string memory json = _buildJSON(rank, nftId, tokenId, tokenMinter[tokenId]);
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function _buildJSON(uint8 rank, uint8 nftId, uint256 tokenId, address minter) private view returns (string memory) {
        return string(abi.encodePacked(
            '{"name":"', _nftName(rank, nftId), ' #', Strings.toString(tokenId), '",',
            '"description":"Silver Void Order NFT. Rank ', Strings.toString(rank), ' of 4. ', _rankName(rank), '.",',
            '"image":"', _imageURI(rank, nftId), '",',
            '"attributes":[',
            '{"trait_type":"Rank","value":', Strings.toString(rank), '},',
            '{"trait_type":"Rank Name","value":"', _rankName(rank), '"},',
            '{"trait_type":"NFT Name","value":"', _nftName(rank, nftId), '"},',
            '{"trait_type":"Rarity","value":"', _rarity(nftId), '"},',
            '{"trait_type":"zkLTC Burned","value":"', _formatBurned(minter), '"},',
            '{"trait_type":"Network","value":"LiteForge"}',
            ']}'
        ));
    }

    // ═══════════════════════════════════════════
    // ERC-721 STANDARD (TRANSFERABLE)
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

    function approve(address to, uint256 tokenId) external {
        address owner = _owners[tokenId];
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "ERC721: not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(to != address(0), "ERC721: transfer to zero address");
        address owner = _owners[tokenId];
        require(owner == from, "ERC721: not owner");
        require(
            msg.sender == owner ||
            _tokenApprovals[tokenId] == msg.sender ||
            _operatorApprovals[owner][msg.sender],
            "ERC721: not authorized"
        );
        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;
        delete _tokenApprovals[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        transferFrom(from, to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd   // ERC-721
            || interfaceId == 0x5b5e139f   // ERC-721Metadata
            || interfaceId == 0x01ffc9a7   // ERC-165
            || interfaceId == 0x2a55205a;  // EIP-2981 Royalties
    }

    // ═══════════════════════════════════════════
    // READ HELPERS
    // ═══════════════════════════════════════════

    function hasClaimed(address wallet, uint8 rankId, uint8 nftId) external view returns (bool) {
        return mintedNFT[wallet][rankId][nftId] != 0;
    }

    function canMint(address wallet, uint8 rankId, uint8 nftId) external view returns (bool) {
        if (rankId < MIN_RANK || rankId > MAX_RANK) return false;
        if (nftId > _maxNFTId(rankId)) return false;
        if (mintedNFT[wallet][rankId][nftId] != 0) return false;
        return ISilverVoid(SILVER_VOID).getRank(wallet) >= rankId;
    }

    // ═══════════════════════════════════════════
    // PRIVATE HELPERS
    // ═══════════════════════════════════════════

    function _maxNFTId(uint8 rank) private pure returns (uint8) {
        if (rank == 4) return 0;
        if (rank == 3) return 1;
        return 2;
    }

    function _rankName(uint8 rank) private pure returns (string memory) {
        if (rank == 4) return "Silver Maximalist";
        if (rank == 3) return "Devoted Litecoiner";
        if (rank == 2) return "Apprentice Litecoiner";
        if (rank == 1) return "Simple Holder";
        return "The Void";
    }

    function _nftName(uint8 rank, uint8 nftId) private pure returns (string memory) {
        if (rank == 1 && nftId == 0) return "The Litecoin Revelation";
        if (rank == 1 && nftId == 1) return "My First Coin";
        if (rank == 1 && nftId == 2) return "The Voyage Begins";
        if (rank == 2 && nftId == 0) return "Spreading the Word";
        if (rank == 2 && nftId == 1) return "Don't be afraid of FUD";
        if (rank == 2 && nftId == 2) return "Strengthening the Chain";
        if (rank == 3 && nftId == 0) return "Kill the FUD!";
        if (rank == 3 && nftId == 1) return "MimbleWimble User";
        if (rank == 4 && nftId == 0) return "The Silver Throne";
        return "Unknown";
    }

    function _rarity(uint8 nftId) private pure returns (string memory) {
        if (nftId == 2) return "Epic";
        if (nftId == 1) return "Rare";
        return "Common";
    }

    function _imageURI(uint8 rank, uint8 nftId) private pure returns (string memory) {
        string memory base = "https://beige-defiant-boa-301.mypinata.cloud/ipfs/";
        if (rank == 1 && nftId == 0) return string(abi.encodePacked(base, "bafybeigawfx6p33p25pclgzjrpazm6a35hkbd2v2jbjotxyxa7awsrmofy"));
        if (rank == 1 && nftId == 1) return string(abi.encodePacked(base, "bafybeihqpwfgljm5lnq2ztag43bqobbcehsbqiszajg7lwi3fjmcbhvrvu"));
        if (rank == 1 && nftId == 2) return string(abi.encodePacked(base, "bafybeialzivo7vvpuwtar5a3ywjto2bnj4avic4vmrys4hrygyahpdsrnm"));
        if (rank == 2 && nftId == 0) return string(abi.encodePacked(base, "bafybeicpwxcjnwk3sfjrfcb6mv67q5sbp7eckslrvxmpbt2ejrgy3rgm2i"));
        if (rank == 2 && nftId == 1) return string(abi.encodePacked(base, "bafybeiguzgo6mgabgejzwovmhrh42qmelht57ij6u75gcqipybhtvquyru"));
        if (rank == 2 && nftId == 2) return string(abi.encodePacked(base, "bafybeib2a5dsgetiq55b7pxvmkddbscran2phkl3fjetqpdl5bpjl6cp5a"));
        if (rank == 3 && nftId == 0) return string(abi.encodePacked(base, "bafybeihx6rva74ucbfp4oz2pzo2jt5bzhovvphdxjxhixk6enmepu424tm"));
        if (rank == 3 && nftId == 1) return string(abi.encodePacked(base, "bafybeiex5rrboz6yhh2efgjkwlcjwgfc2mdqvvsgawfvagzwf7lqjalkbe"));
        if (rank == 4 && nftId == 0) return string(abi.encodePacked(base, "bafybeih7a7esome33rby4spi3d4xgdiiqeqqmy5zkmfqggiml4eah4ebty"));
        return "";
    }

    function _formatBurned(address wallet) private view returns (string memory) {
        uint256 wei_ = ISilverVoid(SILVER_VOID).burnedAmount(wallet);
        uint256 whole = wei_ / 1e18;
        uint256 dec   = (wei_ % 1e18) / 1e15;
        return string(abi.encodePacked(
            Strings.toString(whole), ".",
            dec < 10 ? "00" : dec < 100 ? "0" : "",
            Strings.toString(dec),
            " zkLTC"
        ));
    }
}
