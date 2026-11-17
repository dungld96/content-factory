import { describe, expect, it } from 'vitest';

import { MoneyError, UsdAmount } from './money.js';

describe('UsdAmount', () => {
  it.each([
    ['0', '0'],
    ['3', '3'],
    ['0.0012', '0.0012'],
    ['1.500', '1.5'],
    ['0.000000000000000001', '0.000000000000000001'],
    ['4.16e-8', '0.0000000416'],
    ['1E+2', '100'],
    ['12.', '12'],
  ])('parses %s as %s', (input, expected) => {
    expect(UsdAmount.parse(input).toString()).toBe(expected);
  });

  it('keeps a sub-micro-dollar price exactly (the reason micros were rejected)', () => {
    const price = UsdAmount.parse('0.000000023'); // USD 0.023 per million tokens
    expect(price.times(10).toString()).toBe('0.00000023');
    expect(price.times(10).isZero()).toBe(false);
  });

  it('parses JSON numbers from their shortest round-trip form', () => {
    expect(UsdAmount.parse(0.0012).toString()).toBe('0.0012');
    expect(UsdAmount.parse(1.5e-7).toString()).toBe('0.00000015');
    expect(UsdAmount.parse(0).isZero()).toBe(true);
  });

  it('rounds beyond 18 decimals half to even, and reports it', () => {
    const published = '0.0000000416666666666667'; // 22 decimals, as OpenRouter publishes it
    expect(UsdAmount.parse(published).toString()).toBe('0.000000041666666667');
    expect(UsdAmount.isExact(published)).toBe(false);
    expect(UsdAmount.isExact('0.0012')).toBe(true);
    expect(UsdAmount.isExact('1e-18')).toBe(true);
    expect(UsdAmount.parse('0.0000000000000000005').toString()).toBe('0'); // tie → even (0)
    expect(UsdAmount.parse('0.0000000000000000015').toString()).toBe('0.000000000000000002');
    expect(UsdAmount.parse('0.0000000000000000025').toString()).toBe('0.000000000000000002');
  });

  it.each(['-1', '', 'abc', '1,5', '.5', '0x10', 'NaN', '1e5000'])('rejects %j', (input) => {
    expect(() => UsdAmount.parse(input)).toThrow(MoneyError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.5])('rejects the number %d', (input) => {
    expect(() => UsdAmount.parse(input)).toThrow(MoneyError);
  });

  it('rejects amounts beyond NUMERIC(38,18)', () => {
    expect(() => UsdAmount.parse('99999999999999999999')).not.toThrow();
    expect(() => UsdAmount.parse('100000000000000000000')).toThrow(MoneyError);
  });

  it('adds, sums, multiplies and compares exactly', () => {
    const a = UsdAmount.parse('0.1');
    const b = UsdAmount.parse('0.2');
    expect(a.add(b).toString()).toBe('0.3');
    expect(UsdAmount.sum([a, b, a]).toString()).toBe('0.4');
    expect(UsdAmount.sum([]).isZero()).toBe(true);
    expect(a.times(3n).toString()).toBe('0.3');
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.equals(UsdAmount.parse('0.10'))).toBe(true);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects quantity %d', (quantity) => {
    expect(() => UsdAmount.parse('1').times(quantity)).toThrow(MoneyError);
  });

  it('serializes to a decimal string, never a JSON number', () => {
    expect(JSON.stringify({ cost: UsdAmount.parse('0.00012') })).toBe('{"cost":"0.00012"}');
  });

  it('round-trips through units', () => {
    const amount = UsdAmount.parse('12.345678901234567891');
    expect(UsdAmount.fromUnits(amount.units).equals(amount)).toBe(true);
    expect(() => UsdAmount.fromUnits(-1n)).toThrow(MoneyError);
  });
});
