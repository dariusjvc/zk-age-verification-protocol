pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

/*
 * AgeCheck Circuit
 * ================
 * Proves that a person is at least MIN_AGE_SECONDS old without
 * revealing their actual birth date.
 *
 * Private inputs (never revealed):
 *   - birthTimestamp : Unix timestamp (seconds) of the user's date of birth
 *   - secret         : Random salt chosen by the user for the commitment
 *
 * Public inputs (visible to verifier / on-chain):
 *   - currentTimestamp : Unix timestamp at proof generation time
 *   - commitment       : Poseidon(birthTimestamp, secret) — registered on-chain by issuer
 *   - nullifier        : Poseidon(secret, birthTimestamp) — prevents proof replay
 *
 * Template parameter:
 *   - MIN_AGE_SECONDS  : Minimum age in seconds (18 years ≈ 567,648,000 s)
 *
 * Constraints:
 *   1. commitment  == Poseidon(birthTimestamp, secret)
 *   2. nullifier   == Poseidon(secret, birthTimestamp)
 *   3. birthTimestamp < currentTimestamp  (sane ordering)
 *   4. currentTimestamp - birthTimestamp >= MIN_AGE_SECONDS
 */
template AgeCheck(MIN_AGE_SECONDS) {

    // ───── Private inputs ─────────────────────────────────────────
    signal input birthTimestamp;
    signal input secret;

    // ───── Public inputs ──────────────────────────────────────────
    signal input currentTimestamp;
    signal input commitment;
    signal input nullifier;

    // ═════════════════════════════════════════════════════════════
    // 1. Verify commitment: commitment == Poseidon(birthTimestamp, secret)
    // ═════════════════════════════════════════════════════════════
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== birthTimestamp;
    commitmentHasher.inputs[1] <== secret;

    commitment === commitmentHasher.out;

    // ═════════════════════════════════════════════════════════════
    // 2. Verify nullifier: nullifier == Poseidon(secret, birthTimestamp)
    //    (argument order flipped so nullifier ≠ commitment)
    // ═════════════════════════════════════════════════════════════
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== birthTimestamp;

    nullifier === nullifierHasher.out;

    // ═════════════════════════════════════════════════════════════
    // 3. Verify birthTimestamp < currentTimestamp
    //    Using 64-bit LessThan (Unix timestamps fit in 64 bits until year 5×10^11)
    // ═════════════════════════════════════════════════════════════
    component validOrder = LessThan(64);
    validOrder.in[0] <== birthTimestamp;
    validOrder.in[1] <== currentTimestamp;
    validOrder.out === 1;

    // ═════════════════════════════════════════════════════════════
    // 4. Age check: currentTimestamp - birthTimestamp >= MIN_AGE_SECONDS
    //    GreaterEqThan(64) checks that in[0] >= in[1] within 64-bit range
    // ═════════════════════════════════════════════════════════════
    signal ageSeconds;
    ageSeconds <== currentTimestamp - birthTimestamp;

    component ageChecker = GreaterEqThan(64);
    ageChecker.in[0] <== ageSeconds;
    ageChecker.in[1] <== MIN_AGE_SECONDS;
    ageChecker.out === 1;
}

// ─────────────────────────────────────────────────────────────────────
// Main: 18 years in seconds = 18 × 365 × 86400 = 567,648,000
// Public signals: currentTimestamp, commitment, nullifier
// ─────────────────────────────────────────────────────────────────────
component main { public [currentTimestamp, commitment, nullifier] } = AgeCheck(567648000);
