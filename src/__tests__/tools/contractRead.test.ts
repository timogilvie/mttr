import { describe, it, expect } from 'vitest';
import {
  executeContractRead,
  contractReadTool,
  type ContractReader,
  type ContractReadArgs,
} from '../../tools/contractRead.js';

function fakeReader(returns: Record<string, unknown>): ContractReader & {
  calls: Array<{ fn: string; args: unknown[] }>;
} {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    calls,
    read(fn: string, args: unknown[]): Promise<unknown> {
      calls.push({ fn, args });
      return Promise.resolve(returns[fn]);
    },
  };
}

describe('contract_read op mapping', () => {
  it('paused -> paused() and formats the bool', async () => {
    const r = fakeReader({ paused: true });
    const out = await executeContractRead({ op: 'paused' } as ContractReadArgs, r);
    expect(out).toContain('paused() = true');
    expect(r.calls[0]).toEqual({ fn: 'paused', args: [] });
  });

  it('has_pauser_role -> hasRole(PAUSER_ROLE, addr)', async () => {
    const addr = '0x' + '11'.repeat(20);
    const r = fakeReader({ hasRole: false });
    const out = await executeContractRead({ op: 'has_pauser_role', address: addr } as ContractReadArgs, r);
    expect(out).toContain(`hasRole(PAUSER_ROLE, ${addr}) = false`);
    const call = r.calls[0]!;
    expect(call.fn).toBe('hasRole');
    expect(call.args[1]).toBe(addr);
    expect(call.args[0]).toMatch(/^0x[0-9a-f]{64}$/); // the keccak PAUSER_ROLE bytes32
  });

  it('mint_budget_remaining -> mintBudgetRemaining(modelId), bigint stringified', async () => {
    const r = fakeReader({ mintBudgetRemaining: 1500000n * 10n ** 18n });
    const out = await executeContractRead(
      { op: 'mint_budget_remaining', model_id: 30 } as ContractReadArgs,
      r,
    );
    expect(out).toContain('mintBudgetRemaining(30) = 1500000000000000000000000');
    expect(r.calls[0]).toEqual({ fn: 'mintBudgetRemaining', args: [30] });
  });

  it('current_model_head -> currentModelHead(modelId)', async () => {
    const head = '0x' + 'ab'.repeat(32);
    const r = fakeReader({ currentModelHead: head });
    const out = await executeContractRead(
      { op: 'current_model_head', model_id: 930 } as ContractReadArgs,
      r,
    );
    expect(out).toContain(`currentModelHead(930) = ${head}`);
  });
});

describe('contract_read schema', () => {
  const parse = (v: unknown) => contractReadTool.argsSchema.safeParse(v);

  it('accepts paused with no extra args', () => {
    expect(parse({ op: 'paused' }).success).toBe(true);
  });

  it('requires address for is_attester / has_pauser_role', () => {
    expect(parse({ op: 'is_attester' }).success).toBe(false);
    expect(parse({ op: 'has_pauser_role' }).success).toBe(false);
  });

  it('requires model_id for mint_budget_remaining / current_model_head', () => {
    expect(parse({ op: 'mint_budget_remaining' }).success).toBe(false);
    expect(parse({ op: 'current_model_head' }).success).toBe(false);
  });

  it('rejects a malformed address and an unknown op', () => {
    expect(parse({ op: 'is_attester', address: '0xnope' }).success).toBe(false);
    expect(parse({ op: 'not_a_real_op' }).success).toBe(false);
  });
});
