export type SyncStatus = 'synced' | 'pending' | 'failed';

export type UnitWeight = 'kg' | 'lb';
export type UnitDistance = 'km' | 'mi';

export type LocalProfile = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  unitWeight: UnitWeight;
  unitDistance: UnitDistance;
  defaultTimezone: string;
  deletionRequestedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

/** Fields the client is allowed to write (matches the `profiles` GRANT UPDATE column list). */
export type ProfileWritableFields = Partial<{
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  unitWeight: UnitWeight;
  unitDistance: UnitDistance;
  defaultTimezone: string;
  deletionRequestedAt: string | null;
}>;

export type ConsentCategory = 'health' | 'location' | 'camera';

export type LocalConsent = {
  id: string;
  userId: string;
  category: ConsentCategory;
  purposeVersion: string;
  grantedAt: string;
  revokedAt: string | null;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type Sex = 'female' | 'male' | 'intersex' | 'other' | 'prefer_not_to_say';

export type LocalProfileHealth = {
  userId: string;
  sex: Sex | null;
  dateOfBirth: string | null; // ISO date (YYYY-MM-DD)
  heightCm: number | null;
  syncStatus: SyncStatus;
  lastSyncError: string | null;
};

export type ProfileHealthWritableFields = Partial<{
  sex: Sex | null;
  dateOfBirth: string | null;
  heightCm: number | null;
}>;
