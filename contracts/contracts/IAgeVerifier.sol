// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IAgeVerifier
 * @notice Shared interface for the Groth16 age verifier.
 *         Imported by AgeRegistry so it can be swapped without redeploying.
 */
interface IAgeVerifier {
    function verifyProof(
        uint256[2]    calldata a,
        uint256[2][2] calldata b,
        uint256[2]    calldata c,
        uint256[3]    calldata publicSignals
    ) external view returns (bool);
}
