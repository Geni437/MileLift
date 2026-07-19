import { classifyAuthError } from '../lib/authErrors';

describe('classifyAuthError', () => {
  it('classifies an already-registered email', () => {
    const result = classifyAuthError({ message: 'User already registered' });
    expect(result.kind).toBe('email_in_use');
  });

  it('classifies invalid login credentials without revealing which field was wrong', () => {
    const result = classifyAuthError({ message: 'Invalid login credentials' });
    expect(result.kind).toBe('invalid_credentials');
  });

  it('classifies a weak password', () => {
    const result = classifyAuthError({ message: 'Password should be at least 8 characters' });
    expect(result.kind).toBe('weak_password');
  });

  it('classifies an unverified email', () => {
    const result = classifyAuthError({ message: 'Email not confirmed' });
    expect(result.kind).toBe('unverified_email');
  });

  it('classifies a rate limit by status code', () => {
    const result = classifyAuthError({ message: 'Too many requests', status: 429 });
    expect(result.kind).toBe('rate_limited');
  });

  it('classifies a network failure', () => {
    const result = classifyAuthError(new TypeError('Network request failed'));
    expect(result.kind).toBe('network_offline');
  });

  it('falls back to unknown for an unrecognized error, never throwing', () => {
    const result = classifyAuthError({ message: 'some new Supabase error string we have never seen' });
    expect(result.kind).toBe('unknown');
    expect(result.message).toBeTruthy();
  });

  it('handles a non-Error thrown value without throwing itself', () => {
    expect(() => classifyAuthError('a raw string error')).not.toThrow();
  });
});
