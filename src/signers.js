// Both signers expose the viem-local-account shape @nktkas/hyperliquid's ExchangeClient takes:
// { address, signTypedData({ domain, types, primaryType, message }) }.
import { privateKeyToAccount } from "viem/accounts";

const WAYFINDER_API = "https://wayfinder.ai/api/v1";

export function localKeySigner(privateKey, expectedAddress) {
  const hex = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(hex);
  if (expectedAddress && account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(`Key is for ${account.address}, not the configured hedge wallet ${expectedAddress}`);
  }
  return account;
}

// The backend JSON-decodes typed data, so bigints become numbers when safe and strings otherwise
// (mirrors the SDK's _sanitize_typed_data) and Uint8Arrays become 0x hex.
function jsonSafe(value) {
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return `0x${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}

function eip712DomainType(domain) {
  const fields = [
    ["name", "string"],
    ["version", "string"],
    ["chainId", "uint256"],
    ["verifyingContract", "address"],
    ["salt", "bytes32"],
  ];
  return fields.filter(([k]) => domain[k] !== undefined).map(([name, type]) => ({ name, type }));
}

export function wayfinderSigner(apiKey, address) {
  if (!apiKey.startsWith("wk_")) throw new Error("Wayfinder API keys start with wk_");
  return {
    address: address.toLowerCase(),
    async signTypedData({ domain, types, primaryType, message }) {
      const typedData = jsonSafe({
        domain,
        types: { EIP712Domain: eip712DomainType(domain), ...types },
        primaryType,
        message,
      });
      const res = await fetch(`${WAYFINDER_API}/wallets/${address}/sign-typed-data/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({ typed_data: typedData }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Wayfinder signer ${res.status}: ${body.slice(0, 200)}`);
      }
      const { signature } = await res.json();
      return signature;
    },
  };
}

export function buildSigner(secret, hedgeWallet) {
  if (secret.mode === "key") return localKeySigner(secret.secret, hedgeWallet);
  if (secret.mode === "wayfinder") {
    if (!hedgeWallet) throw new Error("A Wayfinder API key needs the hedge wallet address in settings");
    return wayfinderSigner(secret.secret, hedgeWallet);
  }
  throw new Error(`Unknown signer mode ${secret.mode}`);
}
