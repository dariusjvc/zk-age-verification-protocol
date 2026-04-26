/**
 * backend/src/credential.ts
 * W3C Verifiable Credential creation and verification for age attestation.
 */

import { createVerifiableCredentialJwt, verifyCredential } from "did-jwt-vc";
import { EthrDID } from "ethr-did";
import { Resolver } from "did-resolver";
import { v4 as uuidv4 } from "uuid";
import type { AgeVerifiableCredential, AgeCredentialSubject } from "./types.js";

const VC_CONTEXT = [
  "https://www.w3.org/2018/credentials/v1",
  "https://w3id.org/security/suites/jws-2020/v1",
];

const VC_TYPE = ["VerifiableCredential", "AgeVerificationCredential"];

// ─── VC validity period ───────────────────────────────────────────────
const VC_VALIDITY_DAYS = 365;

function parseBirthDateParts(birthDate: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = birthDate.match(/^(\d{4})-(\d{2})-(\d{02})$/);
  if (!match) {
    throw new Error("birthDate must be in YYYY-MM-DD format");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return { year, month, day };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Converts YYYY-MM-DD to a Unix timestamp (start of day UTC).
 */
export function birthDateToTimestamp(birthDate: string): number {
  const { year, month, day } = parseBirthDateParts(birthDate);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid birth date: ${birthDate}`);
  }
  const ts = Math.floor(date.getTime() / 1000);
  if (ts <= 0) throw new Error("Birth date must be after epoch");
  return ts;
}

/**
 * Validates that a birth date string is YYYY-MM-DD and is in the past.
 */
export function validateBirthDate(birthDate: string): void {
  const birthTimestamp = birthDateToTimestamp(birthDate);
  const now = Math.floor(Date.now() / 1000);
  if (birthTimestamp >= now) {
    throw new Error("birthDate must be in the past");
  }
  // Sanity: not before 1900
  if (birthTimestamp < -2208988800) {
    throw new Error("birthDate is too far in the past");
  }
}

// ─── Issue VC ─────────────────────────────────────────────────────────

/**
 * Creates and signs a W3C Verifiable Credential attesting to a holder's birth date.
 *
 * @param issuerDid     EthrDID instance of the issuer (has signing capability)
 * @param issuerDidStr  DID string of the issuer
 * @param holderDid     DID string of the credential holder
 * @param birthDate     YYYY-MM-DD date of birth
 * @returns             VC as a signed JWT string
 */
export async function issueAgeCredential(
  issuerDid: EthrDID,
  issuerDidStr: string,
  holderDid: string,
  birthDate: string
): Promise<{ vcJwt: string; credential: AgeVerifiableCredential }> {
  validateBirthDate(birthDate);

  const birthTimestamp = birthDateToTimestamp(birthDate);
  const now = new Date();
  const expiry = new Date(now.getTime() + VC_VALIDITY_DAYS * 86400 * 1000);

  const credentialSubject: AgeCredentialSubject = {
    id: holderDid,
    birthDate,
    birthTimestamp,
  };

  const vcPayload = {
    vc: {
      "@context": VC_CONTEXT,
      type: VC_TYPE,
      credentialSubject,
    },
    sub: holderDid,
    iss: issuerDidStr,
    nbf: Math.floor(now.getTime() / 1000),
    exp: Math.floor(expiry.getTime() / 1000),
    jti: `urn:uuid:${uuidv4()}`,
  };

  const vcJwt = await createVerifiableCredentialJwt(vcPayload as any, issuerDid as any);

  const credential: AgeVerifiableCredential = {
    "@context": VC_CONTEXT,
    id: vcPayload.jti,
    type: VC_TYPE,
    issuer: issuerDidStr,
    issuanceDate: now.toISOString(),
    expirationDate: expiry.toISOString(),
    credentialSubject,
  };

  return { vcJwt, credential };
}

// ─── Verify VC ────────────────────────────────────────────────────────

/**
 * Verifies a signed VC JWT.
 * @returns { valid, holder, birthDate, reason }
 */
export async function verifyAgeCredential(
  vcJwt: string,
  resolver: Resolver
): Promise<{
  valid: boolean;
  holder?: string;
  birthDate?: string;
  reason?: string;
}> {
  try {
    const verified = await verifyCredential(vcJwt, resolver);

    if (!verified.verified) {
      return { valid: false, reason: "Signature verification failed" };
    }

    const vc = verified.verifiableCredential;
    if (!vc.type.includes("AgeVerificationCredential")) {
      return { valid: false, reason: "Not an AgeVerificationCredential" };
    }

    const subject = vc.credentialSubject as AgeCredentialSubject;
    const birthDate = subject.birthDate;
    const holder = subject.id;

    return { valid: true, holder, birthDate };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `Verification error: ${message}` };
  }
}
