// The local instance the E2E smoke runs against (docs/testing.md, *apps/admin*).

// FUREA_E2E_PORT lets several checkouts run the smoke side by side.
export const PORT = Number(process.env["FUREA_E2E_PORT"] ?? 8789);
export const BASE_URL = `http://localhost:${PORT}`;
/** Seeded by global-setup.ts as the operator password; 12+ characters like the installer's (ADR 0003). */
export const OPERATOR_PASSWORD = "e2e-operator-password";
