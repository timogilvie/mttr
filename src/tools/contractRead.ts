import { ethers } from 'ethers';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './types.js';

/**
 * Read-only on-chain reads of the DeltaVerifier mint-authority contract, so the Investigate stage
 * can root-cause CONTRACT/mint-path incidents (e.g. a `stale_ingestion` or DeltaOne anomaly surfaced
 * in the health report) and reason about the right mitigation — not just AWS infra.
 *
 * Strictly read-only: a fixed whitelist of view functions, eth_call only, never a signing path.
 * Needs CONTRACTS_RPC_URL (or RPC_URL) + DELTA_VERIFIER_ADDRESS in the environment.
 */

export class ContractReadToolError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ContractReadToolError';
  }
}

const DELTA_VERIFIER_ABI = [
  'function paused() view returns (bool)',
  'function legacyMintsDisabled() view returns (bool)',
  'function attesterThreshold() view returns (uint256)',
  'function attesterCount() view returns (uint256)',
  'function isAttester(address) view returns (bool)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function mintBudgetRemaining(uint256) view returns (uint256)',
  'function currentModelHead(uint256) view returns (bytes32)',
];

const PAUSER_ROLE = ethers.id('PAUSER_ROLE');

const OPS = [
  'paused',
  'legacy_mints_disabled',
  'attester_threshold',
  'attester_count',
  'is_attester',
  'has_pauser_role',
  'mint_budget_remaining',
  'current_model_head',
] as const;

const ADDRESS_OPS = ['is_attester', 'has_pauser_role'] as const;
const MODEL_OPS = ['mint_budget_remaining', 'current_model_head'] as const;

const argsSchema = z
  .object({
    op: z.enum(OPS),
    address: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
      .optional(),
    model_id: z.number().int().nonnegative().optional(),
  })
  .refine((a) => !(ADDRESS_OPS as readonly string[]).includes(a.op) || a.address !== undefined, {
    message: 'address is required for is_attester / has_pauser_role',
    path: ['address'],
  })
  .refine((a) => !(MODEL_OPS as readonly string[]).includes(a.op) || a.model_id !== undefined, {
    message: 'model_id is required for mint_budget_remaining / current_model_head',
    path: ['model_id'],
  });

export type ContractReadArgs = z.infer<typeof argsSchema>;

/** Transport seam: one eth_call read. Injected in tests; defaults to an ethers Contract. */
export interface ContractReader {
  read(fn: string, args: unknown[]): Promise<unknown>;
}

/**
 * Map a validated op to its view call + a human-readable line. Pure (no I/O) so the op mapping is
 * unit-tested with a fake reader; the ethers/RPC transport is isolated in `envReader`.
 */
export async function executeContractRead(
  args: ContractReadArgs,
  reader: ContractReader,
): Promise<string> {
  switch (args.op) {
    case 'paused':
      return `DeltaVerifier.paused() = ${await reader.read('paused', [])}`;
    case 'legacy_mints_disabled':
      return `DeltaVerifier.legacyMintsDisabled() = ${await reader.read('legacyMintsDisabled', [])}`;
    case 'attester_threshold':
      return `DeltaVerifier.attesterThreshold() = ${String(await reader.read('attesterThreshold', []))}`;
    case 'attester_count':
      return `DeltaVerifier.attesterCount() = ${String(await reader.read('attesterCount', []))}`;
    case 'is_attester':
      return `DeltaVerifier.isAttester(${args.address}) = ${await reader.read('isAttester', [args.address])}`;
    case 'has_pauser_role':
      return `DeltaVerifier.hasRole(PAUSER_ROLE, ${args.address}) = ${await reader.read('hasRole', [PAUSER_ROLE, args.address])}`;
    case 'mint_budget_remaining':
      return `DeltaVerifier.mintBudgetRemaining(${args.model_id}) = ${String(await reader.read('mintBudgetRemaining', [args.model_id]))} (wei, 18dp)`;
    case 'current_model_head':
      return `DeltaVerifier.currentModelHead(${args.model_id}) = ${await reader.read('currentModelHead', [args.model_id])}`;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new ContractReadToolError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs).unref?.(),
    ),
  ]);
}

function envReader(ctx: ToolContext): ContractReader {
  const rpcUrl = process.env['CONTRACTS_RPC_URL'] || process.env['RPC_URL'];
  const address = process.env['DELTA_VERIFIER_ADDRESS'];
  if (!rpcUrl) {
    throw new ContractReadToolError('CONTRACTS_RPC_URL (or RPC_URL) is not set');
  }
  if (!address) {
    throw new ContractReadToolError('DELTA_VERIFIER_ADDRESS is not set');
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(address, DELTA_VERIFIER_ABI, provider);
  return {
    read(fn: string, callArgs: unknown[]): Promise<unknown> {
      const method = contract.getFunction(fn);
      return withTimeout(method(...callArgs) as Promise<unknown>, ctx.timeoutMs, fn);
    },
  };
}

async function handler(args: ContractReadArgs, ctx: ToolContext): Promise<string> {
  try {
    return await executeContractRead(args, envReader(ctx));
  } catch (error) {
    if (error instanceof ContractReadToolError) {
      throw error;
    }
    throw new ContractReadToolError(
      `contract_read failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

const parametersJsonSchema = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: OPS,
      description:
        'The DeltaVerifier view to read: paused, legacy_mints_disabled, attester_threshold, attester_count, is_attester (needs address), has_pauser_role (needs address), mint_budget_remaining (needs model_id), current_model_head (needs model_id).',
    },
    address: {
      type: 'string',
      description: 'A 0x-prefixed address; required for is_attester and has_pauser_role.',
    },
    model_id: {
      type: 'integer',
      description: 'The uint model id (e.g. 30, 930); required for mint_budget_remaining and current_model_head.',
    },
  },
  required: ['op'],
} as const;

export const contractReadTool: ToolDefinition<ContractReadArgs> = {
  name: 'contract_read',
  description:
    'Read-only on-chain reads of the DeltaVerifier mint-authority contract (paused state, legacy-mint disable flag, attester registry/threshold, PAUSER_ROLE holder, per-model mint budget, lineage head). Use to root-cause a contract/mint-path incident (e.g. a stale_ingestion or DeltaOne anomaly) and reason about mitigations (pause via the dedicated key, attester rotation). eth_call only; never writes.',
  parametersJsonSchema,
  argsSchema,
  handler,
};
