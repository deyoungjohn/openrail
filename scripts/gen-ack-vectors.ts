/**
 * Generates fixtures/vectors/ack-v1.json — Openrail (Blueprint 2.7) acknowledgement and cancel
 * co-signature vectors, produced independently by viem.
 *
 *   pnpm exec tsx scripts/gen-ack-vectors.ts           write the fixture
 *   pnpm exec tsx scripts/gen-ack-vectors.ts --check   fail if the committed fixture differs
 *
 * The signer is derived from a public string. It is a TEST key: never fund it or use it on a
 * network that holds value. The vectors are deterministic (same inputs, same output).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashTypedData, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "fixtures/vectors/ack-v1.json");
const CHECK = process.argv.includes("--check");

const CHAIN_IDS = [1, 8453, 42161, 10, 137, 56] as const;
const VERIFYING_CONTRACT = "0x0000000000000000000000000000000000000000" as const;
const TEST_SIGNER_SEED =
  "openrail ack-v1 vectors, public test signer — never use on a network holding value";

const signer = privateKeyToAccount(keccak256(toBytes(TEST_SIGNER_SEED)));
const domain = (chainId: number) =>
  ({
    name: "Openrail",
    version: "1",
    chainId,
    verifyingContract: VERIFYING_CONTRACT,
  }) as const;

const ACK_TYPES = {
  Acknowledge: [
    { name: "kind", type: "string" },
    { name: "rootContract", type: "string" },
    { name: "tokenId", type: "string" },
    { name: "termsHash", type: "bytes32" },
    { name: "amountDue", type: "uint256" },
    { name: "dueDate", type: "uint64" },
  ],
} as const;

const CANCEL_TYPES = {
  Cancel: [
    { name: "kind", type: "string" },
    { name: "rootContract", type: "string" },
    { name: "tokenId", type: "string" },
  ],
} as const;

const ACK_KIND = "OPENRAIL_ACK_V1";
const CANCEL_KIND = "OPENRAIL_CANCEL_V1";

type AckInput = {
  chain_id: number;
  root_contract: string;
  token_id: string;
  terms_hash: `0x${string}`;
  amount_due: string;
  due_date: number;
};

type CancelInput = {
  chain_id: number;
  root_contract: string;
  token_id: string;
};

type AckVector = AckInput & {
  name: string;
  kind: string;
  digest: `0x${string}`;
  signer: `0x${string}`;
  signature: `0x${string}`;
};

type CancelVector = CancelInput & {
  name: string;
  kind: string;
  digest: `0x${string}`;
  signer: `0x${string}`;
  signature: `0x${string}`;
};

function ackMessage(input: AckInput) {
  return {
    kind: ACK_KIND,
    rootContract: input.root_contract,
    tokenId: input.token_id,
    termsHash: input.terms_hash,
    amountDue: BigInt(input.amount_due),
    dueDate: BigInt(input.due_date),
  } as const;
}

function cancelMessage(input: CancelInput) {
  return {
    kind: CANCEL_KIND,
    rootContract: input.root_contract,
    tokenId: input.token_id,
  } as const;
}

async function makeAck(name: string, input: AckInput): Promise<AckVector> {
  const typed = {
    domain: domain(input.chain_id),
    types: ACK_TYPES,
    primaryType: "Acknowledge" as const,
    message: ackMessage(input),
  };
  return {
    name,
    kind: ACK_KIND,
    ...input,
    digest: hashTypedData(typed),
    signer: signer.address,
    signature: await signer.signTypedData(typed),
  };
}

async function makeCancel(name: string, input: CancelInput): Promise<CancelVector> {
  const typed = {
    domain: domain(input.chain_id),
    types: CANCEL_TYPES,
    primaryType: "Cancel" as const,
    message: cancelMessage(input),
  };
  return {
    name,
    kind: CANCEL_KIND,
    ...input,
    digest: hashTypedData(typed),
    signer: signer.address,
    signature: await signer.signTypedData(typed),
  };
}

const ROOTS = ["openrail.near", "openrail-test.near"] as const;

const ackInputs: AckInput[] = CHAIN_IDS.flatMap((chain_id, chain_index) =>
  [0, 1].map((offset) => {
    const index = chain_index * 2 + offset + 1;
    return {
      chain_id,
      root_contract: ROOTS[(chain_index + offset) % ROOTS.length]!,
      token_id: `c-${index}`,
      terms_hash: keccak256(toBytes(`openrail ack-v1 terms ${index}`)),
      amount_due: String(1_000_000 + index * 137),
      due_date: 1_800_000_000 + index * 86_400,
    };
  }),
);

const cancelInputs: CancelInput[] = CHAIN_IDS.map((chain_id, index) => ({
  chain_id,
  root_contract: ROOTS[index % ROOTS.length]!,
  token_id: `c-${index + 1}`,
}));

const ACK_TAMPER_AMOUNT: AckInput = {
  ...ackInputs[0]!,
  amount_due: String(BigInt(ackInputs[0]!.amount_due) + 1n),
};
const ACK_TAMPER_ROOT: AckInput = {
  ...ackInputs[1]!,
  root_contract: "attacker.near",
};
const ACK_TAMPER_CHAIN: AckInput = {
  ...ackInputs[2]!,
  chain_id: ackInputs[2]!.chain_id === 10 ? 1 : 10,
};
const CANCEL_TAMPER_TOKEN: CancelInput = {
  ...cancelInputs[0]!,
  token_id: "c-999",
};

async function build() {
  const ack = await Promise.all(
    ackInputs.map((input, index) => makeAck(`ack-${index + 1}`, input)),
  );
  const cancel = await Promise.all(
    cancelInputs.map((input, index) => makeCancel(`cancel-${index + 1}`, input)),
  );
  const tamperAckSpecs = [
    {
      name: "tamper-ack-amount",
      base: "ack-1",
      tamper_kind: "amount_due",
      input: ACK_TAMPER_AMOUNT,
    },
    {
      name: "tamper-ack-root",
      base: "ack-2",
      tamper_kind: "root_contract",
      input: ACK_TAMPER_ROOT,
    },
    { name: "tamper-ack-chain", base: "ack-3", tamper_kind: "chain_id", input: ACK_TAMPER_CHAIN },
  ] as const;
  const tamperCancelSpecs = [
    {
      name: "tamper-cancel-token",
      base: "cancel-1",
      tamper_kind: "token_id",
      input: CANCEL_TAMPER_TOKEN,
    },
  ] as const;

  const tamper_ack = await Promise.all(
    tamperAckSpecs.map(async (spec) => ({
      ...(await makeAck(spec.name, spec.input)),
      base: spec.base,
      tamper_kind: spec.tamper_kind,
    })),
  );
  const tamper_cancel = await Promise.all(
    tamperCancelSpecs.map(async (spec) => ({
      ...(await makeCancel(spec.name, spec.input)),
      base: spec.base,
      tamper_kind: spec.tamper_kind,
    })),
  );

  return {
    schema: "openrail.ack.v1",
    description:
      "Openrail EIP-712 acknowledgement and cancel co-signature vectors (Blueprint 2.7), generated by viem. Rust must reproduce every digest and recover every signer; a base signature must not verify against a tamper digest.",
    generated_by: "scripts/gen-ack-vectors.ts (viem 2.57.14)",
    domain: {
      name: "Openrail",
      version: "1",
      verifyingContract: VERIFYING_CONTRACT,
    },
    signer: signer.address,
    note: "Public test signer derived from a fixed string. Never fund it or use it on a network that holds value.",
    ack_kind: ACK_KIND,
    cancel_kind: CANCEL_KIND,
    ack,
    cancel,
    tamper_ack,
    tamper_cancel,
  };
}

const json = `${JSON.stringify(await build(), null, 2)}\n`;

if (CHECK) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error("gen-ack-vectors: fixtures/vectors/ack-v1.json is missing");
    process.exit(1);
  }
  if (current !== json) {
    console.error(
      "gen-ack-vectors: fixtures/vectors/ack-v1.json is out of date (run: pnpm exec tsx scripts/gen-ack-vectors.ts)",
    );
    process.exit(1);
  }
  console.log("gen-ack-vectors: up to date");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`gen-ack-vectors: wrote ${OUT}`);
}
