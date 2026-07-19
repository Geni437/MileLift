import { generateUuidV4 } from '../lib/uuid';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuidV4', () => {
  it('produces a well-formed RFC 4122 v4 UUID', () => {
    const id = generateUuidV4();
    expect(id).toMatch(UUID_V4_PATTERN);
  });

  it('produces unique values across many calls (idempotency-key safety)', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateUuidV4()));
    expect(ids.size).toBe(1000);
  });
});
