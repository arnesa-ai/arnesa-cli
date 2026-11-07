/**
 * The only place a credential is stored: the operating system keychain. One entry per origin holds
 * either a device token (`arnesa login`, for a person) or an API key (`arnesa login --key`, for
 * scripting use; the last one stored wins). There is no file fallback (a plaintext credential on
 * disk is the failure the rest of the system is built to avoid); with no keychain the CLI stores
 * nothing and points to `ARNESA_API_KEY`.
 */
export interface Keychain {
  /** False when no OS keychain can be reached on this machine. */
  readonly available: boolean;
  get(): string | null;
  set(token: string): void;
  delete(): void;
}

const SERVICE = 'arnesa';

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

/** One entry per API origin, so a token for one server is never sent to another. */
export async function systemKeychain(origin: string): Promise<Keychain> {
  let entry: KeyringEntry;
  try {
    const { Entry } = await import('@napi-rs/keyring');
    entry = new Entry(SERVICE, origin);
    entry.getPassword(); // a missing backend (headless Linux) throws here, not at construction
  } catch {
    return unavailableKeychain;
  }
  return {
    available: true,
    get: () => {
      try {
        return entry.getPassword();
      } catch {
        return null;
      }
    },
    set: (token) => void entry.setPassword(token),
    delete: () => {
      try {
        entry.deletePassword();
      } catch {
        // nothing stored
      }
    },
  };
}

export const unavailableKeychain: Keychain = {
  available: false,
  get: () => null,
  set: () => {
    throw new Error('No OS keychain is available.');
  },
  delete: () => {},
};

/** An in-memory keychain for tests. */
export function fakeKeychain(initial: string | null = null): Keychain & { value: string | null } {
  const box = { value: initial };
  return {
    available: true,
    get value() {
      return box.value;
    },
    get: () => box.value,
    set: (t) => void (box.value = t),
    delete: () => void (box.value = null),
  } as Keychain & { value: string | null };
}
