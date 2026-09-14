/** Recover only recorded creator evidence; never infer a creator from a fork seed. */
export function recordedCreator(bee: { parentId?: string | null; tags?: string[]; createdById?: string | null }): string | null {
  if (bee.createdById !== undefined) return bee.createdById ?? null;
  if (bee.parentId) return bee.parentId;
  const ids = [...new Set((bee.tags ?? []).filter((tag) => tag.startsWith("apiary:parent="))
    .map((tag) => tag.slice("apiary:parent=".length)).filter((id) => id.length > 0))];
  return ids.length === 1 ? ids[0]! : null;
}
