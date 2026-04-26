/**
 * circuits/scripts/generate_test_proof.ts
 *
 * Generates a test ZK proof for the age_check circuit using snarkjs.
 * Run: npx ts-node scripts/generate_test_proof.ts
 *
 * Prerequisites:
 *   - bash scripts/compile.sh  (produces .wasm)
 *   - bash scripts/setup.sh    (produces .zkey)
 */

import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import path from "path";
import fs from "fs";

const BUILD_DIR = path.join(__dirname, "..", "build");
const CIRCUIT_NAME = "age_check";

// ── Helper: bigint Poseidon hash ─────────────────────────────────────
async function poseidon(inputs: bigint[]): Promise<bigint> {
  const poseidonFn = await buildPoseidon();
  const F = poseidonFn.F;
  const hash = poseidonFn(inputs);
  return BigInt(F.toString(hash));
}

async function main() {
  console.log("==> Generating test ZK proof for age_check circuit...\n");

  // ── Test inputs ─────────────────────────────────────────────────────
  // User born January 1, 2000 00:00:00 UTC
  const birthTimestamp = BigInt(946684800);

  // Current time: April 12, 2026 00:00:00 UTC
  const currentTimestamp = BigInt(1744416000);

  // Random secret (in production: cryptographically random)
  const secret = BigInt(
    "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2"
  );

  // Age: 26+ years → should pass the 18-year check
  const ageSeconds = currentTimestamp - birthTimestamp;
  console.log(`Birth timestamp : ${birthTimestamp}`);
  console.log(`Current timestamp: ${currentTimestamp}`);
  console.log(`Age (seconds)   : ${ageSeconds}`);
  console.log(`Age (years)     : ${Number(ageSeconds) / (365 * 86400)}\n`);

  // ── Compute public signals ──────────────────────────────────────────
  const commitment = await poseidon([birthTimestamp, secret]);
  const nullifier = await poseidon([secret, birthTimestamp]);

  console.log(`Commitment : ${commitment}`);
  console.log(`Nullifier  : ${nullifier}\n`);

  // ── Build witness input ─────────────────────────────────────────────
  const input = {
    birthTimestamp: birthTimestamp.toString(),
    secret: secret.toString(),
    currentTimestamp: currentTimestamp.toString(),
    commitment: commitment.toString(),
    nullifier: nullifier.toString(),
  };

  // ── Check build artifacts ───────────────────────────────────────────
  const wasmPath = path.join(BUILD_DIR, `${CIRCUIT_NAME}_js`, `${CIRCUIT_NAME}.wasm`);
  const zkeyPath = path.join(BUILD_DIR, `${CIRCUIT_NAME}_final.zkey`);
  const vkeyPath = path.join(BUILD_DIR, "verification_key.json");

  if (!fs.existsSync(wasmPath)) {
    console.error(`ERROR: WASM not found at ${wasmPath}`);
    console.error("Run: bash scripts/compile.sh");
    process.exit(1);
  }
  if (!fs.existsSync(zkeyPath)) {
    console.error(`ERROR: zkey not found at ${zkeyPath}`);
    console.error("Run: bash scripts/setup.sh");
    process.exit(1);
  }

  // ── Generate proof ──────────────────────────────────────────────────
  console.log("==> Computing witness and generating Groth16 proof...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasmPath,
    zkeyPath
  );

  console.log("\n==> Proof generated:");
  console.log(JSON.stringify(proof, null, 2));
  console.log("\n==> Public signals:");
  console.log(publicSignals);

  // ── Verify proof locally ────────────────────────────────────────────
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(`\n==> Proof valid: ${isValid}`);

  // ── Export calldata for Solidity ────────────────────────────────────
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  console.log("\n==> Solidity calldata (for AgeRegistry.verifyAge):");
  console.log(calldata);

  // Save to file
  const outputPath = path.join(BUILD_DIR, "test_proof.json");
  fs.writeFileSync(
    outputPath,
    JSON.stringify({ proof, publicSignals, solidityCalldata: calldata }, null, 2)
  );
  console.log(`\n==> Proof saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
