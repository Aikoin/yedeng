export interface ReferenceState { pinnedAssetIds: string[]; activeAssetId: string | null }
export type ReferenceAction = { type: 'pin'; assetId: string; replaceId?: string } | { type: 'unpin'; assetId: string } | { type: 'expand'; assetId: string } | { type: 'close' };
export class ReferenceLimitError extends Error {
  constructor(public readonly pinnedAssetIds: readonly string[]) { super('已置顶三张，请选择要替换的参考图；取消会保留原状'); this.name = 'ReferenceLimitError'; }
}
export function referenceTransition(previous: ReferenceState, action: ReferenceAction): ReferenceState {
  const pins = [...new Set(previous.pinnedAssetIds)];
  if (pins.length > 3) throw new Error('置顶状态损坏，请先取消部分置顶');
  let active = previous.activeAssetId;
  if (action.type === 'close') active = null;
  else if (action.type === 'unpin') { const index = pins.indexOf(action.assetId); if (index >= 0) pins.splice(index, 1); if (active === action.assetId) active = null; }
  else if (action.type === 'expand') { if (!pins.includes(action.assetId)) throw new Error('只能展开已置顶资源'); active = action.assetId; }
  else {
    if (!pins.includes(action.assetId)) {
      if (pins.length === 3) {
        const index = action.replaceId ? pins.indexOf(action.replaceId) : -1;
        if (index < 0) throw new ReferenceLimitError(pins);
        pins.splice(index, 1, action.assetId);
      } else pins.push(action.assetId);
    }
    active = action.assetId;
  }
  return { pinnedAssetIds: pins, activeAssetId: active && pins.includes(active) ? active : null };
}
