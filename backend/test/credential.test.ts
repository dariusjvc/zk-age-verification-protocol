import test from "node:test";
import assert from "node:assert/strict";

import { birthDateToTimestamp, validateBirthDate } from "../src/credential.js";

test("birthDateToTimestamp returns UTC timestamp for a valid leap day", () => {
  assert.equal(birthDateToTimestamp("2000-02-29"), 951782400);
});

test("validateBirthDate rejects impossible calendar dates", () => {
  assert.throws(
    () => validateBirthDate("2024-02-31"),
    /Invalid birth date: 2024-02-31/
  );
});

test("validateBirthDate rejects dates in the future", () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const yyyy = future.getUTCFullYear();
  const mm = String(future.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(future.getUTCDate()).padStart(2, "0");

  assert.throws(
    () => validateBirthDate(`${yyyy}-${mm}-${dd}`),
    /birthDate must be in the past/
  );
});