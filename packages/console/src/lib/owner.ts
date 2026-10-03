/**
 * The account id carries its own registration key: owner_id = "ow_" +
 * base58(32-byte account key) (packages/api/src/control/identity.ts). The
 * console never holds a private half — the key is an opaque account
 * identifier that the passkey registration endpoints take back as-is, so the
 * console can always re-derive it from the signed-in account with nothing to
 * type and no chance of registering a passkey against the wrong account.
 */
export function accountKeyFromOwnerId(ownerId: string): string {
  if (!ownerId.startsWith('ow_') || ownerId.length <= 3) {
    throw new Error(`not an owner id: ${ownerId}`);
  }
  return ownerId.slice(3);
}
