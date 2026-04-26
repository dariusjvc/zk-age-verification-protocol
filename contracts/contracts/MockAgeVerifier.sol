// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IAgeVerifier.sol";

/**
 * @title MockAgeVerifier
 * @notice Test mock that always returns true for any proof.
 *         NEVER deploy this to production.
 */
contract MockAgeVerifier is IAgeVerifier {
    function verifyProof(
        uint256[2]    calldata,
        uint256[2][2] calldata,
        uint256[2]    calldata,
        uint256[3]    calldata
    ) external pure override returns (bool) {
        return true;
    }
}
