/**
 * Who sees the operator pages: ADMIN_OWNER_IDS, comma-separated owner ids.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 */
export function isAdminOwner(env: { ADMIN_OWNER_IDS?: string } | undefined, ownerId: string | undefined): boolean {
  if (!ownerId) return false;
  return (env?.ADMIN_OWNER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(ownerId);
}
