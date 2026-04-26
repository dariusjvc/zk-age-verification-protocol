/**
 * frontend/src/api-client.ts
 * Type-safe HTTP client for the VC Issuer backend.
 */

const BASE_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

// ─── Types (mirrors backend/src/types.ts) ─────────────────────────────

export interface IssueCredentialResponse {
  vcJwt: string;
  credential: {
    id: string;
    type: string[];
    issuer: string;
    issuanceDate: string;
    expirationDate: string;
    credentialSubject: {
      id: string;
      birthDate: string;
      birthTimestamp: number;
    };
  };
}

export interface SignCommitmentResponse {
  commitment: string;
  issuerAddress: string;
  issuerDid: string;
  issuerSignature: string;
}

export interface VerifyCredentialResponse {
  valid: boolean;
  holder?: string;
  birthDate?: string;
  reason?: string;
}

// ─── Client ───────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/**
 * Requests a Verifiable Credential from the issuer backend.
 * The issuer signs a VC containing the holder's birth date.
 */
export async function issueCredential(
  holderDid: string,
  holderAddress: string,
  birthDate: string
): Promise<IssueCredentialResponse> {
  return apiFetch<IssueCredentialResponse>("/api/credentials/issue", {
    method:  "POST",
    body:    JSON.stringify({ holderDid, holderAddress, birthDate }),
  });
}

/**
 * Asks the issuer to sign a Poseidon commitment for on-chain registration.
 * The commitment is Poseidon(birthTimestamp, secret) — only the commitment is sent,
 * NOT the secret or birth date.
 */
export async function signCommitment(
  holderAddress: string,
  commitment: bigint
): Promise<SignCommitmentResponse> {
  return apiFetch<SignCommitmentResponse>("/api/commitments/sign", {
    method:  "POST",
    body:    JSON.stringify({ holderAddress, commitment: commitment.toString() }),
  });
}

/**
 * Verifies a VC JWT with the issuer backend.
 */
export async function verifyCredential(vcJwt: string): Promise<VerifyCredentialResponse> {
  return apiFetch<VerifyCredentialResponse>("/api/credentials/verify", {
    method:  "POST",
    body:    JSON.stringify({ vcJwt }),
  });
}
