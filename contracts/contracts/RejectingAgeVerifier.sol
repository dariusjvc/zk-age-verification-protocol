// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IAgeVerifier.sol";

contract RejectingAgeVerifier is IAgeVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[3] calldata
    ) external pure override returns (bool) {
        return false;
    }
}