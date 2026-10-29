import { describe, it, expect } from 'vitest';
import { listBackStep } from '../list-back';

describe('listBackStep', () => {
  it('ends selection mode first', () => {
    expect(listBackStep({ selecting: true, searching: true })).toBe('clear-selection');
  });

  it('clears an open search instead of leaving the app', () => {
    expect(listBackStep({ selecting: false, searching: true })).toBe('clear-search');
  });

  it('leaves only from a plain list', () => {
    expect(listBackStep({ selecting: false, searching: false })).toBe('leave');
  });
});
