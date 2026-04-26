/**
 * backend/src/types.ts
 * Shared types for the VC issuer backend.
 */

// ─── W3C Verifiable Credential types ─────────────────────────────────

export interface VCProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  jws?: string;
  proofValue?: string;
}

export interface AgeCredentialSubject {
  id: string; // DID of the holder
  birthDate: string; // ISO 8601 date (YYYY-MM-DD)
  birthTimestamp: number; // Unix timestamp (start of day, UTC)
}

export interface AgeVerifiableCredential {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: AgeCredentialSubject;
  proof?: VCProof;
}

// ─── API request/response types ───────────────────────────────────────

export interface IssueCredentialRequest {
  /**
   * DID of the credential holder (e.g. "did:ethr:1:0x...")
   */
  holderDid: string;
  /**
   * Holder's Ethereum address (used for on-chain commitment registration)
   */
  holderAddress: string;
  /**
   * Date of birth in YYYY-MM-DD format
   */
  birthDate: string;
}

export interface IssueCredentialResponse {
  credential: AgeVerifiableCredential;
  /** Signed JWT representation of the VC */
  vcJwt: string;
}

export interface RegisterCommitmentRequest {
  /**
   * Holder's Ethereum address
   */
  holderAddress: string;
  /**
   * Poseidon(birthTimestamp, secret) — computed off-chain by holder
   */
  commitment: string; // hex string or decimal string
}

export interface RegisterCommitmentResponse {
  txHash: string;
  commitment: string;
  issuerSignature: string;
}

export interface VerifyCredentialRequest {
  vcJwt: string;
}

export interface VerifyCredentialResponse {
  valid: boolean;
  holder?: string;
  birthDate?: string;
  reason?: string;
}

// ─── Internal types ───────────────────────────────────────────────────

export interface IssuerConfig {
  privateKey: string;
  did: string;
  address: string;
  chainId: number;
  rpcUrl: string;
  commitmentRegistryAddress: string;
}
