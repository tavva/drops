// ABOUTME: Verifies drop reference parsing for name and owner/name forms.
// ABOUTME: Pins which malformed references fail as invalid names and which as invalid references.
import { describe, expect, it } from 'vitest';

import { parseDropReference } from '../src/reference.js';

describe('parseDropReference', () => {
  it('parses a bare drop name', () => {
    expect(parseDropReference('site', 'drops cat site index.html')).toEqual({ name: 'site' });
  });

  it('parses an owner/name reference', () => {
    expect(parseDropReference('bob/site', 'drops cat site index.html')).toEqual({ owner: 'bob', name: 'site' });
  });

  it('rejects an invalid bare name as invalid_name', () => {
    expect(() => parseDropReference('Not Valid', 'drops cat site index.html')).toThrow(expect.objectContaining({
      code: 'invalid_name',
      exitCode: 2,
    }));
  });

  it.each(['bob/', '/site', 'bob/site/extra', 'Bob/site', 'bob/si--te', 'bob//site'])(
    'rejects the malformed reference %s',
    (reference) => {
      expect(() => parseDropReference(reference, 'drops cat bob/site index.html')).toThrow(expect.objectContaining({
        code: 'invalid_reference',
        details: { reference },
        exitCode: 2,
      }));
    },
  );
});
