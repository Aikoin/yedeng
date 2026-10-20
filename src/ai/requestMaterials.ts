import { immutableEvidence, type EvidenceAttachment } from '../evidence/types';

/** One ordered source list is shared by the preview, payload and frozen result links. */
export function labelRequestEvidence(docId: string, materials: readonly EvidenceAttachment[], offset = 0): readonly EvidenceAttachment[] {
  if (materials.some(item => item.docId !== docId)) throw new Error('拒绝混入其他文献证据');
  return immutableEvidence(materials.map((item, index) => ({ ...item, label: `E${index + 1 + offset} · ${item.label}` })));
}

/** Local asset identity stays out of model input and content-cache identity. */
export function evidenceMessageContent(materials: readonly EvidenceAttachment[]): import('./types').VisionContent[] {
  return materials.flatMap(material => {
    const header: import('./types').VisionContent={type:'text',text:`[${material.label.split(' · ')[0]}] ${material.label} · PDF ${material.pageIndices.length?material.pageIndices.map(index=>index+1).join('、'):'页码未定位'}`};
    if(material.kind==='text' && material.text)return [header,{type:'text' as const,text:material.text}];
    if(material.kind==='image' && material.image)return [header,{type:'image_url' as const,image_url:{url:material.image,detail:'high' as const}}];
    return [header];
  });
}
