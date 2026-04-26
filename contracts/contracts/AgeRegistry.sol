// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IAgeVerifier.sol";
import "./CommitmentRegistry.sol";

/**
 * @title AgeRegistry
 * @notice Main contract for privacy-preserving age verification.
 *
 * @dev  End-to-end flow:
 *   1. Issuer registers commitment in CommitmentRegistry
 *   2. User generates ZK proof off-chain (Rust prover or browser snarkjs)
 *   3. User calls verifyAge() with the proof and public signals
 *   4. Contract:
 *        a. Checks merkle proof timestamp is within acceptable window
 *        b. Checks commitment matches what the user registered
 *        c. Checks nullifier has not been used before
 *        d. Calls AgeVerifier.verifyProof() — the Groth16 check
 *        e. Marks address as verified (with expiry)
 */
contract AgeRegistry {
    // ─── Dependencies ─────────────────────────────────────────────────
    IAgeVerifier        public immutable verifier;
    CommitmentRegistry  public immutable commitmentRegistry;

    // ─── Constants ────────────────────────────────────────────────────
    /// @notice Verification attestations expire after 1 year.
    uint256 public constant VERIFICATION_VALIDITY = 365 days;

    /// @notice Proof timestamp must be within ±10 minutes of block time.
    uint256 public constant TIMESTAMP_TOLERANCE = 10 minutes;

    // ─── State ────────────────────────────────────────────────────────

    /// @notice nullifier → used? (prevents proof replay attacks)
    mapping(uint256 => bool) public usedNullifiers;

    /// @notice user address → attestation expiry timestamp (0 = not verified)
    mapping(address => uint256) public verificationExpiry;

    // ─── Events ───────────────────────────────────────────────────────
    event AgeVerified(
        address indexed user,
        uint256 indexed nullifier,
        uint256         expiresAt
    );

    event VerificationRevoked(address indexed user);

    // ─── Constructor ──────────────────────────────────────────────────
    constructor(address _verifier, address _commitmentRegistry) {
        require(_verifier != address(0),           "AgeRegistry: zero verifier");
        require(_commitmentRegistry != address(0), "AgeRegistry: zero registry");
        verifier           = IAgeVerifier(_verifier);
        commitmentRegistry = CommitmentRegistry(_commitmentRegistry);
    }

    // ─── Core function ─────────────────────────────────────────────────

    /**
     * @notice Submit a ZK proof to verify your age (≥ 18 years).
     *
     * @param proofA          Groth16 proof element A  (G1 point)
     * @param proofB          Groth16 proof element B  (G2 point)
     * @param proofC          Groth16 proof element C  (G1 point)
     * @param currentTimestamp Unix timestamp used as public input in the proof
     * @param nullifier       Poseidon(secret, birthTimestamp) — prevents reuse
     *
     * @dev The commitment is fetched from CommitmentRegistry[msg.sender].
     *      Public signals order must match the circuit: [currentTimestamp, commitment, nullifier]
     */
    function verifyAge(
        uint256[2]    calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2]    calldata proofC,
        uint256                currentTimestamp,
        uint256                nullifier
    ) external {
        // ── 1. Nullifier check (replay prevention) ────────────────────
        require(!usedNullifiers[nullifier], "AgeRegistry: proof already used");

        // ── 2. Timestamp sanity check ─────────────────────────────────
        require(
            currentTimestamp >= block.timestamp - TIMESTAMP_TOLERANCE,
            "AgeRegistry: timestamp too old"
        );
        require(
            currentTimestamp <= block.timestamp + TIMESTAMP_TOLERANCE,
            "AgeRegistry: timestamp in future"
        );

        // ── 3. Fetch user's registered commitment ─────────────────────
        uint256 commitment = commitmentRegistry.getCommitment(msg.sender);
        require(commitment != 0, "AgeRegistry: no active commitment for user");

        // ── 4. Verify Groth16 ZK proof ────────────────────────────────
        uint256[3] memory publicSignals = [currentTimestamp, commitment, nullifier];
        require(
            verifier.verifyProof(proofA, proofB, proofC, publicSignals),
            "AgeRegistry: invalid ZK proof"
        );

        // ── 5. Record attestation ─────────────────────────────────────
        usedNullifiers[nullifier] = true;
        uint256 expiresAt = block.timestamp + VERIFICATION_VALIDITY;
        verificationExpiry[msg.sender] = expiresAt;

        emit AgeVerified(msg.sender, nullifier, expiresAt);
    }

    // ─── View functions ───────────────────────────────────────────────

    /**
     * @notice Returns true if the user has a valid, non-expired age attestation.
     */
    function isVerified(address user) external view returns (bool) {
        return verificationExpiry[user] > block.timestamp;
    }

    /**
     * @notice Returns the timestamp when the user's verification expires (0 if not verified).
     */
    function getVerificationExpiry(address user) external view returns (uint256) {
        return verificationExpiry[user];
    }
}
