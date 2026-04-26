// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IssuerRegistry
 * @notice Registry of trusted Verifiable Credential issuers.
 *         Each issuer is identified by a DID and an Ethereum address.
 *         Only the contract owner can add or revoke issuers.
 *
 * @dev DIDs follow the format:  did:ethr:<chainId>:<address>
 *      Example: did:ethr:1:0xAbCd...
 */
contract IssuerRegistry {
    // ─── State ────────────────────────────────────────────────────────
    address public owner;

    struct Issuer {
        string  did;
        address ethAddress;
        string  name;
        bool    active;
        uint256 registeredAt;
    }

    /// @dev did string → Issuer record
    mapping(string => Issuer) private _issuers;

    /// @dev Ethereum address → DID string (for quick lookup)
    mapping(address => string) private _addressToDID;

    // ─── Events ───────────────────────────────────────────────────────
    event IssuerRegistered(
        string  indexed did,
        address indexed ethAddress,
        string          name
    );

    event IssuerRevoked(string indexed did, address indexed ethAddress);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ─── Modifiers ────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "IssuerRegistry: not owner");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────
    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ─── Admin functions ──────────────────────────────────────────────

    /**
     * @notice Register a new trusted issuer.
     * @param did        DID string (e.g. "did:ethr:1:0x...")
     * @param ethAddress Ethereum address controlled by the issuer
     * @param name       Human-readable name
     */
    function registerIssuer(
        string  calldata did,
        address          ethAddress,
        string  calldata name
    ) external onlyOwner {
        require(bytes(did).length > 0,  "IssuerRegistry: empty DID");
        require(ethAddress != address(0), "IssuerRegistry: zero address");
        require(!_issuers[did].active,  "IssuerRegistry: already registered");
        require(
            bytes(_addressToDID[ethAddress]).length == 0,
            "IssuerRegistry: address already used"
        );

        _issuers[did] = Issuer({
            did:          did,
            ethAddress:   ethAddress,
            name:         name,
            active:       true,
            registeredAt: block.timestamp
        });
        _addressToDID[ethAddress] = did;

        emit IssuerRegistered(did, ethAddress, name);
    }

    /**
     * @notice Revoke an issuer (marks as inactive; does NOT delete commitments).
     * @param did DID of the issuer to revoke.
     */
    function revokeIssuer(string calldata did) external onlyOwner {
        require(_issuers[did].active, "IssuerRegistry: issuer not active");
        address ethAddr = _issuers[did].ethAddress;
        _issuers[did].active = false;
        emit IssuerRevoked(did, ethAddr);
    }

    /**
     * @notice Transfer ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "IssuerRegistry: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── View functions ───────────────────────────────────────────────

    /**
     * @notice Returns true if the given Ethereum address belongs to an active issuer.
     */
    function isValidIssuer(address ethAddress) external view returns (bool) {
        string memory did = _addressToDID[ethAddress];
        if (bytes(did).length == 0) return false;
        return _issuers[did].active;
    }

    /**
     * @notice Returns the full issuer record for a given DID.
     */
    function getIssuer(string calldata did) external view returns (Issuer memory) {
        return _issuers[did];
    }

    /**
     * @notice Returns the DID associated with an Ethereum address.
     */
    function getDIDByAddress(address ethAddress) external view returns (string memory) {
        return _addressToDID[ethAddress];
    }
}
