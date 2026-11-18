// Plain-language explanations for Hashgate's custom errors and checkPayment() reason codes.

export const REASONS: Record<number, string> = {
  0: "Allowed by the session policy.",
  1: "This session does not exist.",
  2: "The owner revoked this session. The agent can no longer spend.",
  3: "This session has expired.",
  4: "The amount is above the session's per-payment cap.",
  5: "This payment would exceed the session's total budget.",
  6: "This payee is not on the session's allowlist.",
  7: "The vault does not hold enough tUSD8.",
  8: "The amount must be greater than zero.",
};

export const ERROR_TEXT: Record<string, string> = {
  UnknownVault: "No vault with this id exists.",
  VaultExists: "A vault with this key and salt already exists.",
  BadKey: "The key commitment is malformed (height must be 1–12, root and seed non-zero).",
  BadSignature: "The post-quantum signature does not match the committed key.",
  LeafAlreadyUsed: "This one-time key was already used. One-time keys can sign only once.",
  UnknownSession: "This session does not exist.",
  SessionExists: "This session key is already registered.",
  SessionIsRevoked: REASONS[2],
  SessionExpired: REASONS[3],
  OverPerPaymentCap: REASONS[4],
  OverBudget: REASONS[5],
  PayeeNotAllowed: REASONS[6],
  InsufficientVaultBalance: REASONS[7],
  ZeroAmount: REASONS[8],
  BadPolicy: "The policy is invalid: caps must be positive, cap ≤ budget, expiry in the future.",
  TransferFailed: "The token transfer failed.",
};

export function explainError(name: string | undefined): string {
  return (name && ERROR_TEXT[name]) || "The transaction was rejected.";
}
