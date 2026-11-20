import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mutate } from './api-client';

vi.mock('./csrf-client', () => ({ csrfToken: () => Promise.resolve('t') }));

const refused = (status: number, code: string) =>
  Response.json(
    { error: { code, message: 'This request (about $4) would exceed the item budget.' } },
    { status },
  );

describe('mutate: budget confirmation (M7 §3)', () => {
  let confirm: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    confirm = vi.fn();
    vi.stubGlobal('window', { confirm });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bodies = () =>
    fetchMock.mock.calls.map((c) => {
      const body = (c[1] as RequestInit).body;
      return JSON.parse(typeof body === 'string' ? body : '') as unknown;
    });

  it('asks once on a soft limit and resends with acceptOverBudget when confirmed', async () => {
    fetchMock
      .mockResolvedValueOnce(refused(409, 'BUDGET_CONFIRMATION_REQUIRED'))
      .mockResolvedValueOnce(Response.json({ ok: 1 }, { status: 202 }));
    confirm.mockReturnValue(true);
    const r = await mutate('POST', '/x/generate', { count: 2 });
    expect(r).toMatchObject({ ok: true, status: 202 });
    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toContain('item budget');
    expect(bodies()).toEqual([{ count: 2 }, { count: 2, acceptOverBudget: true }]);
  });

  it('sends nothing more when the user declines', async () => {
    fetchMock.mockResolvedValueOnce(refused(409, 'BUDGET_CONFIRMATION_REQUIRED'));
    confirm.mockReturnValue(false);
    const r = await mutate('POST', '/x/generate', {});
    expect(r).toMatchObject({ ok: false, status: 409, code: 'BUDGET_CONFIRMATION_REQUIRED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('never retries a hard limit', async () => {
    fetchMock.mockResolvedValueOnce(refused(402, 'BUDGET_EXCEEDED'));
    const r = await mutate('POST', '/x/generate', {});
    expect(r).toMatchObject({ ok: false, status: 402, code: 'BUDGET_EXCEEDED' });
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
