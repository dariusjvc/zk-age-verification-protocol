/**
 * frontend/src/main.ts
 * Main entry point — orchestrates wallet connection, VC issuance,
 * ZK proof generation, and on-chain submission.
 */

import { connectWallet, getAddress, registerCommitmentOnChain, revokeCommitmentOnChain, getExistingCommitment, submitAgeProof, checkVerificationStatus } from "./wallet.js";
import { generateAgeProof, computeCommitment, generateSecret } from "./prover.js";
import { issueCredential, signCommitment } from "./api-client.js";

// ─── Contract addresses (populated by deploy script) ─────────────────
// In production, these come from deployment-addresses.json or env vars.
const AGE_REGISTRY_ADDR        = import.meta.env.VITE_AGE_REGISTRY_ADDRESS        ?? "";
const COMMITMENT_REGISTRY_ADDR = import.meta.env.VITE_COMMITMENT_REGISTRY_ADDRESS ?? "";

// ─── State ────────────────────────────────────────────────────────────
let userAddress   = "";
let vcJwt         = "";
let birthTimestamp = 0n;
let proofData: Awaited<ReturnType<typeof generateAgeProof>> | null = null;

// ─── UI helpers ───────────────────────────────────────────────────────

function setStatus(
  elementId: string,
  text: string,
  kind: "idle" | "pending" | "success" | "error"
) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const icon = { idle: "○", pending: "⏳", success: "✅", error: "❌" }[kind];
  el.innerHTML = `<span class="status-badge ${kind}">${icon} ${text}</span>`;
}

function appendLog(logId: string, msg: string, kind: "info" | "ok" | "err" = "info") {
  const log = document.getElementById(logId);
  if (!log) return;
  log.style.display = "block";
  const entry = document.createElement("div");
  entry.className = `entry ${kind}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function setButtonEnabled(id: string, enabled: boolean) {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (btn) btn.disabled = !enabled;
}

// ─── Step 1: Connect Wallet ───────────────────────────────────────────

document.getElementById("btn-connect")?.addEventListener("click", async () => {
  try {
    setStatus("wallet-status", "Connecting...", "pending");
    userAddress = await connectWallet();
    setStatus("wallet-status", `Connected: ${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`, "success");

    // Check if already verified
    if (AGE_REGISTRY_ADDR) {
      const { verified, expiresAt } = await checkVerificationStatus(AGE_REGISTRY_ADDR, userAddress);
      if (verified) {
        const banner = document.getElementById("verified-banner");
        if (banner) {
          banner.style.display = "block";
          banner.textContent = `✅ Age already verified on-chain! Expires: ${expiresAt?.toLocaleDateString()}`;
        }
      }
    }

    setButtonEnabled("btn-issue-vc", true);

    // Set max date to today for birth date picker
    const dateInput = document.getElementById("birth-date") as HTMLInputElement | null;
    if (dateInput) dateInput.max = new Date().toISOString().split("T")[0];
  } catch (err) {
    setStatus("wallet-status", err instanceof Error ? err.message : "Connection failed", "error");
  }
});

// ─── Step 2: Issue Verifiable Credential ─────────────────────────────

document.getElementById("btn-issue-vc")?.addEventListener("click", async () => {
  const dateInput = document.getElementById("birth-date") as HTMLInputElement | null;
  const birthDate = dateInput?.value;

  if (!birthDate) {
    setStatus("vc-status", "Please enter your birth date", "error");
    return;
  }

  if (!userAddress) {
    setStatus("vc-status", "Connect wallet first", "error");
    return;
  }

  setStatus("vc-status", "Requesting credential from issuer...", "pending");

  try {
    // Use a simple DID for the holder (did:pkh would be more correct in production)
    const holderDid = `did:ethr:${userAddress.toLowerCase()}`;

    const response = await issueCredential(holderDid, userAddress, birthDate);
    vcJwt = response.vcJwt;
    birthTimestamp = BigInt(response.credential.credentialSubject.birthTimestamp);

    setStatus("vc-status", `Credential issued (expires ${new Date(response.credential.expirationDate).toLocaleDateString()})`, "success");
    setButtonEnabled("btn-generate-proof", true);
    setStatus("proof-status", "Ready to generate proof", "idle");
  } catch (err) {
    setStatus("vc-status", err instanceof Error ? err.message : "Request failed", "error");
  }
});

// ─── Step 3: Generate ZK Proof ────────────────────────────────────────

document.getElementById("btn-generate-proof")?.addEventListener("click", async () => {
  if (!vcJwt || birthTimestamp === 0n) {
    setStatus("proof-status", "Get a credential first", "error");
    return;
  }

  setStatus("proof-status", "Generating ZK proof (this may take ~30s)...", "pending");
  setButtonEnabled("btn-generate-proof", false);

  const logId = "proof-log";

  try {
    // 1. Generate a random secret (never leaves browser)
    const secret = generateSecret();
    appendLog(logId, "Random secret generated (stays in browser)");

    // 2. Compute commitment to register with issuer
    const commitment = await computeCommitment(birthTimestamp, secret);
    appendLog(logId, `Commitment: ${commitment.toString().slice(0, 20)}...`);

    // 3. Get issuer signature on commitment
    appendLog(logId, "Requesting issuer signature on commitment...");
    const { issuerSignature } = await signCommitment(userAddress, commitment);
    appendLog(logId, "Issuer signature received", "ok");

    // 4. Register commitment on-chain
    if (!COMMITMENT_REGISTRY_ADDR) {
      appendLog(logId, "COMMITMENT_REGISTRY_ADDRESS not set — skipping on-chain registration", "err");
    } else {
      // If a previous attempt already registered a commitment, revoke it first.
      const existing = await getExistingCommitment(COMMITMENT_REGISTRY_ADDR, userAddress);
      if (existing !== 0n) {
        appendLog(logId, "Revoking previous commitment...");
        await revokeCommitmentOnChain(COMMITMENT_REGISTRY_ADDR);
        appendLog(logId, "Previous commitment revoked.", "ok");
      }
      appendLog(logId, "Registering commitment on-chain...");
      const txHash = await registerCommitmentOnChain(
        COMMITMENT_REGISTRY_ADDR,
        commitment,
        issuerSignature
      );
      appendLog(logId, `Commitment registered! tx: ${txHash.slice(0, 12)}...`, "ok");
    }

    // 5. Generate ZK proof
    appendLog(logId, "Computing ZK proof (browser Wasm)...");
    const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));

    proofData = await generateAgeProof(
      { birthTimestamp, secret, currentTimestamp },
      (msg) => appendLog(logId, msg)
    );

    appendLog(logId, "ZK proof generated successfully!", "ok");
    setStatus("proof-status", "Proof ready ✓", "success");
    setButtonEnabled("btn-submit-proof", true);
    setStatus("submit-status", "Ready to submit", "idle");
  } catch (err) {
    appendLog(logId, err instanceof Error ? err.message : String(err), "err");
    setStatus("proof-status", "Proof generation failed", "error");
    setButtonEnabled("btn-generate-proof", true);
  }
});

// ─── Step 4: Submit Proof On-Chain ────────────────────────────────────

document.getElementById("btn-submit-proof")?.addEventListener("click", async () => {
  if (!proofData) {
    setStatus("submit-status", "Generate a proof first", "error");
    return;
  }
  if (!AGE_REGISTRY_ADDR) {
    setStatus("submit-status", "AGE_REGISTRY_ADDRESS not configured", "error");
    return;
  }

  setStatus("submit-status", "Submitting proof to Ethereum...", "pending");
  setButtonEnabled("btn-submit-proof", false);

  const logId = "submit-log";
  const { calldata } = proofData;

  try {
    appendLog(logId, "Sending transaction to AgeRegistry...");
    const txHash = await submitAgeProof(
      AGE_REGISTRY_ADDR,
      calldata.proofA,
      calldata.proofB,
      calldata.proofC,
      calldata.currentTimestamp,
      calldata.nullifier
    );
    appendLog(logId, `Transaction confirmed: ${txHash}`, "ok");
    setStatus("submit-status", "Age verified on-chain! 🎉", "success");

    const banner = document.getElementById("verified-banner");
    if (banner) banner.style.display = "block";
  } catch (err) {
    appendLog(logId, err instanceof Error ? err.message : String(err), "err");
    setStatus("submit-status", "Transaction failed", "error");
    setButtonEnabled("btn-submit-proof", true);
  }
});
