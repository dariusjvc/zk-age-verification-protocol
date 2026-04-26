#!/usr/bin/env bash
# circuits/scripts/compile.sh
# Compiles the age_check.circom circuit to R1CS + WASM witness generator.
# Requires: circom ≥ 2.0 in PATH
# Usage: cd circuits && bash scripts/compile.sh

set -euo pipefail

CIRCUIT_NAME="age_check"
CIRCUITS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$CIRCUITS_DIR/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"
NODE_MODULES="$CIRCUITS_DIR/node_modules"
ROOT_NODE_MODULES="$ROOT_DIR/node_modules"

echo "==> [compile] Circuit: $CIRCUIT_NAME"
echo "==> [compile] Build dir: $BUILD_DIR"

# ── Prerequisites ────────────────────────────────────────────────────
if command -v circom &>/dev/null; then
  CIRCOM_BIN="$(command -v circom)"
elif [ -x "$HOME/.cargo/bin/circom" ]; then
  CIRCOM_BIN="$HOME/.cargo/bin/circom"
else
  echo "ERROR: circom not found in PATH."
  echo ""
  echo "Install Circom 2.x (Linux) from source:"
  echo "  git clone https://github.com/iden3/circom.git"
  echo "  cd circom"
  echo "  cargo build --release"
  echo "  cargo install --path circom"
  echo ""
  echo "Then ensure cargo bin is in PATH:"
  echo '  export PATH="$HOME/.cargo/bin:$PATH"'
  echo ""
  echo "Docs: https://docs.circom.io/getting-started/installation/"
  exit 1
fi

# ── Prepare directories ──────────────────────────────────────────────
mkdir -p "$BUILD_DIR"

# ── Resolve node_modules (workspace root takes priority) ────────────
# In an npm workspace the packages are hoisted to the repo root.
if [ -d "$ROOT_NODE_MODULES/circomlib" ]; then
  LIB_DIR="$ROOT_NODE_MODULES"
elif [ -d "$NODE_MODULES/circomlib" ]; then
  LIB_DIR="$NODE_MODULES"
else
  echo "==> [compile] circomlib not found – installing npm dependencies..."
  # Run install from the workspace root so hoisting works correctly.
  (cd "$ROOT_DIR" && npm install)
  LIB_DIR="$ROOT_NODE_MODULES"
fi

# ── Compile circuit ──────────────────────────────────────────────────
echo "==> [compile] Running circom compiler..."
"$CIRCOM_BIN" "$CIRCUITS_DIR/$CIRCUIT_NAME.circom" \
  --r1cs \
  --wasm \
  --sym \
  --output "$BUILD_DIR" \
  -l "$LIB_DIR"

echo ""
echo "==> [compile] Done!"
echo "    R1CS:      $BUILD_DIR/$CIRCUIT_NAME.r1cs"
echo "    WASM:      $BUILD_DIR/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"
echo "    Symbols:   $BUILD_DIR/$CIRCUIT_NAME.sym"
echo ""
echo "==> [compile] Next step: bash scripts/setup.sh"
