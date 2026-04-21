// ABOUTME: Unit test for the deterministic rename fallback used when reparenting collides with an existing sibling.
// ABOUTME: Rules: "X (from P)" -> truncate to 64 -> append " (N)" with further base truncation until free.
import { describe, it, expect } from 'vitest';
import { resolveReparentName } from '@/services/folders';

describe('resolveReparentName', () => {
  it('returns base if no collision', () => {
    expect(resolveReparentName('reports', 'deleted', new Set())).toBe('reports');
  });

  it('adds " (from X)" suffix on direct collision', () => {
    expect(resolveReparentName('reports', 'q1', new Set(['reports'])))
      .toBe('reports (from q1)');
  });

  it('appends " (1)", " (2)", ... when the (from X) form also collides', () => {
    const taken = new Set(['reports', 'reports (from q1)']);
    expect(resolveReparentName('reports', 'q1', taken)).toBe('reports (from q1) (1)');
  });

  it('truncates base so the (from X) suffix fits in 64 chars', () => {
    const base = 'a'.repeat(60);
    const parent = 'q1';
    const suffix = ' (from q1)'; // 10 chars
    const result = resolveReparentName(base, parent, new Set([base]));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.endsWith(suffix)).toBe(true);
  });

  it('truncates a long parent name inside the suffix with an ellipsis if needed', () => {
    const base = 'x';
    const parent = 'p'.repeat(80);
    const result = resolveReparentName(base, parent, new Set([base]));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.startsWith('x (from ')).toBe(true);
    expect(result.endsWith(')')).toBe(true);
  });
});
