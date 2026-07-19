import { toOsPermissionStatus } from '../permissions/types';

describe('toOsPermissionStatus', () => {
  it('maps granted', () => {
    expect(toOsPermissionStatus({ status: 'granted' })).toBe('granted');
  });

  it('maps a re-askable denial to denied', () => {
    expect(toOsPermissionStatus({ status: 'denied', canAskAgain: true })).toBe('denied');
  });

  it('maps a non-re-askable denial to blocked (the OS-blocked state)', () => {
    expect(toOsPermissionStatus({ status: 'denied', canAskAgain: false })).toBe('blocked');
  });

  it('maps anything else to undetermined rather than throwing', () => {
    expect(toOsPermissionStatus({ status: 'undetermined' })).toBe('undetermined');
    expect(toOsPermissionStatus({ status: 'unknown-future-status' })).toBe('undetermined');
  });
});
