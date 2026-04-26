/**
 * frontend/src/prover.ts
 * ZKP witness computation and Groth16 proof generation using snarkjs.
 *
 * Runs entirely in the browser — no private data leaves the client.
 */

import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import type { Groth16Proof, PublicSignals } from "snarkjs";

// Paths to circuit artifacts (hosted by Vite from /public/circuits/)
const WASM_PATH = "/circuits/age_check_js/age_check.wasm";
const ZKEY_PATH = "/circuits/age_check_final.zkey";

export interface ProofInput {
  birthTimestamp: bigint;
  secret: bigint;
  currentTimestamp: bigint;
}

export interface GeneratedProof {
  proof: Groth16Proof;
  publicSignals: PublicSignals;
  /** Pre-formatted calldata for AgeRegistry.verifyAge() */
  calldata: {
    proofA: [bigint, bigint];
    proofB: [[bigint, bigint], [bigint, bigint]];
    proofC: [bigint, bigint];
    currentTimestamp: bigint;
    nullifier: bigint;
  };
}

// ─── Poseidon hash (BN254 compatible) ────────────────────────────────

let _poseidonFn: ReturnType<typeof buildPoseidon> extends Promise<infer T> ? T : never;

async function getPoseidon() {
  if (!_poseidonFn) {
    _poseidonFn = await buildPoseidon();
  }
  return _poseidonFn;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon(inputs);
  return BigInt(F.toString(hash));
}

// ─── Commitment and nullifier derivation ─────────────────────────────

/**
 * Computes: commitment = Poseidon(birthTimestamp, secret)
 * This is registered on-chain by the issuer.
 */
export async function computeCommitment(
  birthTimestamp: bigint,
  secret: bigint
): Promise<bigint> {
  return poseidonHash([birthTimestamp, secret]);
}

/**
 * Computes: nullifier = Poseidon(secret, birthTimestamp)
 * This is the one-time proof identifier to prevent replay attacks.
 */
export async function computeNullifier(
  secret: bigint,
  birthTimestamp: bigint
): Promise<bigint> {
  return poseidonHash([secret, birthTimestamp]);
}

/**
 * Generates a cryptographically random secret using Web Crypto API.
 * The secret stays in the browser — never sent to any server.
 */
export function generateSecret(): bigint {
  // Generate 31 bytes to stay safely below the BN254 scalar field modulus
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return BigInt("0x" + hex);
}

// ─── Proof generation ─────────────────────────────────────────────────

/**
 * Generates a Groth16 ZK proof that the user is at least 18 years old.
 *
 * @param onLog  Optional callback for progress logs
 */
export async function generateAgeProof(
  input: ProofInput,
  onLog?: (msg: string) => void
): Promise<GeneratedProof> {
  const log = onLog ?? console.log;

  log("[zkp] Computing Poseidon hashes...");
  const commitment = await computeCommitment(input.birthTimestamp, input.secret);
  const nullifier  = await computeNullifier(input.secret, input.birthTimestamp);

  log(`[zkp] Commitment : ${commitment}`);
  log(`[zkp] Nullifier  : ${nullifier}`);

  // Circuit public inputs (must match component main declaration)
  const circuitInput = {
    birthTimestamp:   input.birthTimestamp.toString(),
    secret:           input.secret.toString(),
    currentTimestamp: input.currentTimestamp.toString(),
    commitment:       commitment.toString(),
    nullifier:        nullifier.toString(),
  };

  log("[zkp] Downloading WASM & zkey (first run may take ~10s)...");

  let proof: Groth16Proof;
  let publicSignals: PublicSignals;

  try {
    const result = await snarkjs.groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH);
    proof         = result.proof as Groth16Proof;
    publicSignals = result.publicSignals as PublicSignals;
  } catch (err) {
    throw new Error(`Proof generation failed: ${err instanceof Error ? err.message : err}`);
  }

  log("[zkp] Proof generated successfully!");

  // Parse calldata for Solidity (snarkjs returns hex strings)
  const cdRaw = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  // cdRaw is a comma-separated string: [pA], [pB], [pC], [inputs]
  const cdParsed = JSON.parse("[" + cdRaw + "]") as [
    [string, string],
    [[string, string], [string, string]],
    [string, string],
    [string, string, string]
  ];

  const b2x = cdParsed[1];
  const calldata = {
    proofA: [BigInt(cdParsed[0][0]), BigInt(cdParsed[0][1])] as [bigint, bigint],
    proofB: [
      [BigInt(b2x[0][0]), BigInt(b2x[0][1])],
      [BigInt(b2x[1][0]), BigInt(b2x[1][1])],
    ] as [[bigint, bigint], [bigint, bigint]],
    proofC: [BigInt(cdParsed[2][0]), BigInt(cdParsed[2][1])] as [bigint, bigint],
    currentTimestamp: BigInt(cdParsed[3][0]),
    nullifier:        BigInt(cdParsed[3][2]),
  };

  return { proof, publicSignals, calldata };
}
