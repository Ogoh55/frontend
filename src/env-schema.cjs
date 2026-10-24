const { z } = require("zod");

const STELLAR_STRKEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function isContractStrkey(value) {
  if (typeof value !== "string" || !/^C[A-Z2-7]{55}$/.test(value)) return false;

  const decoded = [];
  let bits = 0;
  let buffer = 0;
  for (const character of value) {
    const digit = STELLAR_STRKEY_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }

  if (bits !== 0 || decoded.length !== 35 || decoded[0] !== 16) return false;

  let checksum = 0;
  for (const byte of decoded.slice(0, 33)) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum & 0x8000) === 0x8000
        ? ((checksum << 1) ^ 0x1021) & 0xffff
        : (checksum << 1) & 0xffff;
    }
  }

  return decoded[33] === (checksum & 0xff) && decoded[34] === (checksum >>> 8);
}

const contractId = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().refine(isContractStrkey, "must be a valid Stellar contract strkey").optional()
);

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const clientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().optional(),
  NEXT_PUBLIC_STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).optional(),
  NEXT_PUBLIC_STELLAR_TESTNET_CONTRACT_ID: contractId,
  NEXT_PUBLIC_STELLAR_MAINNET_CONTRACT_ID: contractId,
  NEXT_PUBLIC_APP_VERSION: z.string().optional(),
  NEXT_PUBLIC_BUILD_SHA: z.string().optional(),

  // Vaults data source (src/lib/api/vaults.ts). Anything but "live" uses the mock.
  NEXT_PUBLIC_VAULTS: z.enum(["mock", "live"]).optional(),

  // Governance (#89): governable contract IDs, per network. All optional so a
  // deployment without governance still boots — the wizard degrades to a
  // "contracts not configured" state rather than failing at import time.
  NEXT_PUBLIC_CONTRACT_GOVERNOR_TESTNET: contractId,
  NEXT_PUBLIC_CONTRACT_GOVERNOR_MAINNET: contractId,
  NEXT_PUBLIC_CONTRACT_MARKET_TESTNET: contractId,
  NEXT_PUBLIC_CONTRACT_MARKET_MAINNET: contractId,
  NEXT_PUBLIC_CONTRACT_VAULT_TESTNET: contractId,
  NEXT_PUBLIC_CONTRACT_VAULT_MAINNET: contractId,
  NEXT_PUBLIC_CONTRACT_ORACLE_TESTNET: contractId,
  NEXT_PUBLIC_CONTRACT_ORACLE_MAINNET: contractId,
  NEXT_PUBLIC_CONTRACT_TIMELOCK_TESTNET: contractId,
  NEXT_PUBLIC_CONTRACT_TIMELOCK_MAINNET: contractId,
  NEXT_PUBLIC_CONTRACT_DEPLOYER_TESTNET: contractId,
  NEXT_PUBLIC_CONTRACT_DEPLOYER_MAINNET: contractId,
});

const envSchema = serverEnvSchema
  .merge(clientEnvSchema)
  .superRefine((env, context) => {
    if (env.NODE_ENV !== "production") return;

    if (!env.NEXT_PUBLIC_API_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_API_URL"],
        message: "is required for production builds",
      });
    }

    if (!env.NEXT_PUBLIC_STELLAR_NETWORK) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_STELLAR_NETWORK"],
        message: "must be set to testnet or mainnet for production builds",
      });
    }

    const contractKey = env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
      ? "NEXT_PUBLIC_STELLAR_MAINNET_CONTRACT_ID"
      : "NEXT_PUBLIC_STELLAR_TESTNET_CONTRACT_ID";
    if (!env[contractKey]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [contractKey],
        message: `is required for the selected ${env.NEXT_PUBLIC_STELLAR_NETWORK ?? "network"} production build`,
      });
    }
  });

function parseEnv(input) {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }
  return result.data;
}

module.exports = { clientEnvSchema, isContractStrkey, parseEnv, serverEnvSchema };