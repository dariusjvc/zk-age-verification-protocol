#!/usr/bin/env bash
# circuits/scripts/setup.sh
# Runs the Groth16 trusted setup for the age_check circuit:
#   Phase 1 — Powers of Tau (universal, curve-specific)
#   Phase 2 — Circuit-specific setup
#   Exports   — Verification key JSON + Solidity verifier contract
#
# IMPORTANT: For production, use a real multi-party computation (MPC)
# ceremony for Powers of Tau. This script uses a local single-party
# setup suitable ONLY for development/testing.
#
# Requires: snarkjs in PATH (npm i -g snarkjs)
# Usage: cd circuits && bash scripts/setup.sh

set -euo pipefail

CIRCUIT_NAME="age_check"
CIRCUITS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$CIRCUITS_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"
CONTRACTS_DIR="$CIRCUITS_DIR/../contracts/contracts"
FRONTEND_CIRCUITS_DIR="$ROOT_DIR/frontend/public/circuits"

# Powers of Tau parameters
# 2^PTAU_POWER must be >= number of circuit constraints
# age_check circuit has ~300 constraints → power 10 (1024) is sufficient
PTAU_POWER=14   # use 14 for safety (16384 constraints max)
PTAU_FILE="$BUILD_DIR/pot${PTAU_POWER}_final.ptau"
ZKEY_INIT="$BUILD_DIR/${CIRCUIT_NAME}_0000.zkey"
ZKEY_FINAL="$BUILD_DIR/${CIRCUIT_NAME}_final.zkey"
VERIFICATION_KEY="$BUILD_DIR/verification_key.json"

echo "==> [setup] Circuit: $CIRCUIT_NAME"
echo "==> [setup] Build dir: $BUILD_DIR"

# ── Prerequisites ────────────────────────────────────────────────────
# Prefer locally installed snarkjs (npm workspace root) over global.
if command -v snarkjs &>/dev/null; then
  SNARKJS="snarkjs"
elif [ -x "$ROOT_DIR/node_modules/.bin/snarkjs" ]; then
  SNARKJS="$ROOT_DIR/node_modules/.bin/snarkjs"
elif [ -x "$CIRCUITS_DIR/node_modules/.bin/snarkjs" ]; then
  SNARKJS="$CIRCUITS_DIR/node_modules/.bin/snarkjs"
else
  echo "ERROR: snarkjs not found. Run 'npm install' from the repo root."
  exit 1
fi

if [ ! -f "$BUILD_DIR/$CIRCUIT_NAME.r1cs" ]; then
  echo "ERROR: $CIRCUIT_NAME.r1cs not found. Run compile.sh first."
  exit 1
fi

mkdir -p "$BUILD_DIR"

# ── Phase 1: Powers of Tau (BN128 universal trusted setup) ───────────
if [ ! -f "$PTAU_FILE" ]; then
  echo "==> [setup] Phase 1: Starting new Powers of Tau ceremony (power=$PTAU_POWER)..."
  $SNARKJS powersoftau new bn128 $PTAU_POWER "$BUILD_DIR/pot${PTAU_POWER}_0000.ptau" -v

  echo "==> [setup] Phase 1: Contributing to ceremony..."
  $SNARKJS powersoftau contribute \
    "$BUILD_DIR/pot${PTAU_POWER}_0000.ptau" \
    "$BUILD_DIR/pot${PTAU_POWER}_0001.ptau" \
    --name="Dev contribution (NOT for production)" \
    -v -e="random entropy for dev only"

  echo "==> [setup] Phase 1: Preparing phase 2 (beacon)..."
  # In production: use snarkjs powersoftau beacon with a public beacon value
  $SNARKJS powersoftau prepare phase2 \
    "$BUILD_DIR/pot${PTAU_POWER}_0001.ptau" \
    "$PTAU_FILE" \
    -v

  # Clean up intermediate ptau files to save space
  rm -f "$BUILD_DIR/pot${PTAU_POWER}_0000.ptau" "$BUILD_DIR/pot${PTAU_POWER}_0001.ptau"
else
  echo "==> [setup] Phase 1: Reusing existing $PTAU_FILE"
fi

# ── Phase 2: Circuit-specific setup (Groth16) ────────────────────────
echo "==> [setup] Phase 2: Groth16 circuit setup..."
$SNARKJS groth16 setup \
  "$BUILD_DIR/$CIRCUIT_NAME.r1cs" \
  "$PTAU_FILE" \
  "$ZKEY_INIT"

echo "==> [setup] Phase 2: Contributing to circuit zkey..."
$SNARKJS zkey contribute \
  "$ZKEY_INIT" \
  "$ZKEY_FINAL" \
  --name="Circuit contribution (NOT for production)" \
  -v -e="circuit entropy dev"

rm -f "$ZKEY_INIT"

# ── Export Solidity verifier ─────────────────────────────────────────
echo "==> [setup] Exporting Solidity verifier to contracts/..."
mkdir -p "$CONTRACTS_DIR"
$SNARKJS zkey export solidityverifier "$ZKEY_FINAL" "$CONTRACTS_DIR/AgeVerifier.sol"
# snarkjs names the contract "Groth16Verifier"; rename it to match deploy.js expectation.
sed -i 's/contract Groth16Verifier /contract AgeVerifier /' "$CONTRACTS_DIR/AgeVerifier.sol"

# ── Sync frontend proof artifacts ───────────────────────────────────
echo "==> [setup] Syncing proof artifacts to frontend/public/..."
mkdir -p "$FRONTEND_CIRCUITS_DIR"
cp "$ZKEY_FINAL" "$FRONTEND_CIRCUITS_DIR/${CIRCUIT_NAME}_final.zkey"
rm -rf "$FRONTEND_CIRCUITS_DIR/${CIRCUIT_NAME}_js"
cp -R "$BUILD_DIR/${CIRCUIT_NAME}_js" "$FRONTEND_CIRCUITS_DIR/${CIRCUIT_NAME}_js"

# ── Export verification key ──────────────────────────────────────────
echo "==> [setup] Exporting verification key..."
if ! $SNARKJS zkey export verificationkey "$ZKEY_FINAL" "$VERIFICATION_KEY"; then
  echo "WARNING: verification_key export failed; Solidity verifier and frontend assets were still updated."
fi

echo ""
echo "==> [setup] Done!"
echo "    Zkey:              $ZKEY_FINAL"
echo "    Verification key:  $VERIFICATION_KEY"
echo "    Solidity verifier: $CONTRACTS_DIR/AgeVerifier.sol"
echo "    Frontend assets:   $FRONTEND_CIRCUITS_DIR"
echo ""
echo "==> [setup] Next: cd ../contracts && npm run compile && npm run deploy:blockchain-local"
