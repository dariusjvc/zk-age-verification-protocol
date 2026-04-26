// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IssuerRegistry.sol";

/**
 * @title CommitmentRegistry
 * @notice Stores Poseidon commitments to birth dates, issued and signed by
 *         trusted credential issuers.
 *
 * @dev Flow:
 *   1. Issuer computes  commitment = Poseidon(birthTimestamp, secret)
 *   2. Issuer signs     message    = keccak256(abi.encodePacked(userAddress, commitment))
 *   3. User (or issuer) calls      registerCommitment(commitment, issuerSignature)
 *   4. Contract verifies issuer's ECDSA signature and stores the commitment
 *
 *   The commitment is later used as a public input to the ZK proof.
 */
contract CommitmentRegistry {
    // ─── State ────────────────────────────────────────────────────────
    IssuerRegistry public immutable issuerRegistry;

    struct CommitmentRecord {
        uint256 commitment;
        address issuer;
        uint256 registeredAt;
        bool    active;
    }

    /// @dev user address → commitment record
    mapping(address => CommitmentRecord) private _commitments;

    /// @dev commitment value → already registered? (prevents duplicate commitments)
    mapping(uint256 => bool) private _commitmentExists;

    // ─── Events ───────────────────────────────────────────────────────
    event CommitmentRegistered(
        address indexed user,
        uint256 indexed commitment,
        address indexed issuer
    );
    event CommitmentRevoked(address indexed user, uint256 indexed commitment);

    // ─── Constructor ──────────────────────────────────────────────────
    constructor(address _issuerRegistry) {
        require(_issuerRegistry != address(0), "CommitmentRegistry: zero address");
        issuerRegistry = IssuerRegistry(_issuerRegistry);
    }

    // ─── External functions ───────────────────────────────────────────

    /**
     * @notice Register an age commitment signed by a trusted issuer.
     *
     * @param commitment      Poseidon(birthTimestamp, secret) — must match circuit
     * @param issuerSignature ECDSA signature over keccak256(userAddress ++ commitment)
     *
     * @dev The issuer signs:  eth_sign( keccak256(abi.encodePacked(msg.sender, commitment)) )
     *      i.e. the signed message includes the user's address to prevent replay across users.
     */
    function registerCommitment(
        uint256       commitment,
        bytes calldata issuerSignature
    ) external {
        require(commitment != 0, "CommitmentRegistry: zero commitment");
        require(!_commitmentExists[commitment], "CommitmentRegistry: commitment already used");
        require(
            !_commitments[msg.sender].active,
            "CommitmentRegistry: user already has commitment"
        );

        // Recover issuer address from signature
        address issuer = _recoverIssuer(msg.sender, commitment, issuerSignature);
        require(
            issuerRegistry.isValidIssuer(issuer),
            "CommitmentRegistry: signer is not a valid issuer"
        );

        _commitments[msg.sender] = CommitmentRecord({
            commitment:    commitment,
            issuer:        issuer,
            registeredAt:  block.timestamp,
            active:        true
        });
        _commitmentExists[commitment] = true;

        emit CommitmentRegistered(msg.sender, commitment, issuer);
    }

    /**
     * @notice Revoke your own commitment (e.g. if secret is compromised).
     */
    function revokeCommitment() external {
        CommitmentRecord storage rec = _commitments[msg.sender];
        require(rec.active, "CommitmentRegistry: no active commitment");
        rec.active = false;
        emit CommitmentRevoked(msg.sender, rec.commitment);
    }

    // ─── View functions ───────────────────────────────────────────────

    /**
     * @notice Returns the active commitment for a user, or 0 if none.
     */
    function getCommitment(address user) external view returns (uint256) {
        CommitmentRecord storage rec = _commitments[user];
        if (!rec.active) return 0;
        return rec.commitment;
    }

    /**
     * @notice Returns the full commitment record for a user.
     */
    function getCommitmentRecord(address user)
        external
        view
        returns (CommitmentRecord memory)
    {
        return _commitments[user];
    }

    /**
     * @notice Returns true if a commitment value has already been registered.
     */
    function commitmentExists(uint256 commitment) external view returns (bool) {
        return _commitmentExists[commitment];
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    /**
     * @dev Recover the signer of the issuer authorization message.
     *      Message: eth_sign( keccak256(abi.encodePacked(userAddress, commitment)) )
     */
    function _recoverIssuer(
        address        user,
        uint256        commitment,
        bytes calldata sig
    ) internal pure returns (address) {
        bytes32 msgHash = keccak256(abi.encodePacked(user, commitment));
        bytes32 ethHash = _toEthSignedMessageHash(msgHash);
        return _recover(ethHash, sig);
    }

    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function _recover(bytes32 hash, bytes calldata sig)
        internal
        pure
        returns (address)
    {
        require(sig.length == 65, "CommitmentRegistry: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "CommitmentRegistry: invalid signature v");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "CommitmentRegistry: invalid signature");
        return signer;
    }
}
