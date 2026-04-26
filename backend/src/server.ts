/**
 * backend/src/server.ts
 * Express REST API for the Verifiable Credential issuer.
 *
 * Endpoints:
 *   POST /api/credentials/issue          — Issue a signed VC with birth date
 *   POST /api/credentials/verify         — Verify a VC JWT
 *   POST /api/commitments/sign           — Sign a commitment for on-chain registration
 *   GET  /api/health                     — Health check
 */

import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import * as dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { z } from "zod";
import { ethers } from "ethers";

import { createIssuerDID, getDidResolver, isValidDID } from "./did.js";
import { issueAgeCredential, verifyAgeCredential } from "./credential.js";
import { IssuerService } from "./issuer.js";
import type {
  AgeVerifiableCredential,
  IssueCredentialRequest,
  RegisterCommitmentRequest,
  VerifyCredentialRequest,
} from "./types.js";

const ISSUED_VC_STORE_PATH = path.resolve(process.cwd(), "issued-credentials.json");

type StoredIssuedCredential = {
  issuedAt: string;
  holderDid: string;
  vcJwt: string;
  credential: AgeVerifiableCredential;
};

function persistIssuedCredential(entry: StoredIssuedCredential): void {
  let existingEntries: StoredIssuedCredential[] = [];

  if (fs.existsSync(ISSUED_VC_STORE_PATH)) {
    const raw = fs.readFileSync(ISSUED_VC_STORE_PATH, "utf8").trim();
    if (raw.length > 0) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        existingEntries = parsed as StoredIssuedCredential[];
      } else {
        throw new Error("issued-credentials.json must contain a JSON array");
      }
    }
  }

  existingEntries.push(entry);
  fs.writeFileSync(ISSUED_VC_STORE_PATH, JSON.stringify(existingEntries, null, 2), "utf8");
}

// Prefer workspace-root .env (../.env from backend/), then fallback to local backend/.env.
const rootEnvPath = path.resolve(process.cwd(), "../.env");
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
} else {
  dotenv.config();
}

// ─── Configuration ────────────────────────────────────────────────────

const PORT                       = parseInt(process.env.PORT ?? "3001", 10);
const CHAIN_ID                   = parseInt(process.env.CHAIN_ID ?? "31337", 10);
const RPC_URL                    = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const COMMITMENT_REGISTRY_ADDR   = process.env.COMMITMENT_REGISTRY_ADDRESS ?? "";

// The issuer's Ethereum private key — KEEP THIS SECRET
// In production: use a KMS or HSM. Never hardcode.
const ISSUER_PRIVATE_KEY = process.env.ISSUER_PRIVATE_KEY;
if (!ISSUER_PRIVATE_KEY) {
  console.error("ERROR: ISSUER_PRIVATE_KEY env var is required");
  process.exit(1);
}

// ─── Initialize services ──────────────────────────────────────────────

const { did: issuerDid, didString: issuerDidStr, address: issuerAddress } =
  createIssuerDID(ISSUER_PRIVATE_KEY, CHAIN_ID, RPC_URL);

const resolver = getDidResolver(RPC_URL, CHAIN_ID);

const issuerService = new IssuerService({
  privateKey:                 ISSUER_PRIVATE_KEY,
  did:                        issuerDidStr,
  address:                    issuerAddress,
  chainId:                    CHAIN_ID,
  rpcUrl:                     RPC_URL,
  commitmentRegistryAddress:  COMMITMENT_REGISTRY_ADDR,
});

console.log(`Issuer DID    : ${issuerDidStr}`);
console.log(`Issuer address: ${issuerAddress}`);

// ─── Express app ──────────────────────────────────────────────────────

const app = express();

// Security middleware
app.use(helmet());
app.use(express.json({ limit: "10kb" })); // Limit body size

// CORS — only allow configured origins
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",");
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

// ─── Input validation schemas ─────────────────────────────────────────

const issueSchema = z.object({
  holderDid:     z.string().min(10).max(255),
  holderAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  birthDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const signSchema = z.object({
  holderAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  commitment:    z.string().regex(/^\d+$/).max(80), // decimal string
});

const verifySchema = z.object({
  vcJwt: z.string().min(50).max(4096),
});

// ─── Routes ───────────────────────────────────────────────────────────

/**
 * GET /api/health
 */
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status:       "ok",
    issuerDid:    issuerDidStr,
    chainId:      CHAIN_ID,
    timestamp:    new Date().toISOString(),
  });
});

/**
 * POST /api/credentials/issue
 * Issues a signed W3C VC containing the holder's birth date.
 */
app.post("/api/credentials/issue", async (req: Request, res: Response) => {
  const parsed = issueSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { holderDid, birthDate }: IssueCredentialRequest = parsed.data;

  if (!isValidDID(holderDid)) {
    return res.status(400).json({ error: "Invalid holderDid format" });
  }

  try {
    const { vcJwt, credential } = await issueAgeCredential(
      issuerDid,
      issuerDidStr,
      holderDid,
      birthDate
    );

    persistIssuedCredential({
      issuedAt: new Date().toISOString(),
      holderDid,
      vcJwt,
      credential,
    });

    return res.status(201).json({ credential, vcJwt });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(400).json({ error: msg });
  }
});

/**
 * POST /api/credentials/verify
 * Verifies a VC JWT and returns holder info if valid.
 */
app.post("/api/credentials/verify", async (req: Request, res: Response) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  const { vcJwt }: VerifyCredentialRequest = parsed.data;

  const result = await verifyAgeCredential(vcJwt, resolver);
  return res.json(result);
});

/**
 * POST /api/commitments/sign
 * Signs a Poseidon commitment for a holder's on-chain registration.
 *
 * The holder computes commitment = Poseidon(birthTimestamp, secret) locally,
 * then requests the issuer to sign it. The issuer does NOT learn the secret.
 *
 * Security: The issuer verifies the VC is valid before signing (production)
 * or trusts the caller in dev mode.
 */
app.post("/api/commitments/sign", async (req: Request, res: Response) => {
  const parsed = signSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { holderAddress, commitment }: RegisterCommitmentRequest = parsed.data;

  let commitmentBigInt: bigint;
  try {
    commitmentBigInt = BigInt(commitment);
    if (commitmentBigInt === 0n) throw new Error("Commitment cannot be zero");
  } catch {
    return res.status(400).json({ error: "Invalid commitment value" });
  }

  let checksumAddress: string;
  try {
    checksumAddress = ethers.getAddress(holderAddress);
  } catch {
    return res.status(400).json({ error: "Invalid Ethereum address" });
  }

  try {
    const signature = await issuerService.signCommitment(checksumAddress, commitmentBigInt);
    return res.json({
      commitment:       commitmentBigInt.toString(),
      issuerAddress:    issuerAddress,
      issuerDid:        issuerDidStr,
      issuerSignature:  signature,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Signing failed";
    return res.status(500).json({ error: msg });
  }
});

// ─── Error handler ────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nVC Issuer backend listening on http://localhost:${PORT}`);
  console.log(`  POST /api/credentials/issue`);
  console.log(`  POST /api/credentials/verify`);
  console.log(`  POST /api/commitments/sign`);
  console.log(`  GET  /api/health\n`);
});

export default app;
