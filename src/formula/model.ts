import type { PdfQuad } from '../pdf/geometry';
export interface FormulaSegmentRef {assetId:string;assetVersion:number;segmentId:string;pageIndex:number;quad:PdfQuad;cropBlob:Blob;hash:string;width:number;height:number;order:number;rotation:number}
interface FormulaBase {id:string;assetId:string;docId:string;formulaId:string;latex:string;checkedByUser:boolean;createdAt:number}
export interface FormulaSourceRevision extends FormulaBase {kind:'source';revision:number;previousRevisionId?:string;segments:FormulaSegmentRef[];checkedAt?:number|null}
export interface FormulaCandidateRecord extends FormulaBase {kind:'candidate';sourceRevisionId:string;warnings:string[];model?:string;snapshotHash?:string;status:'candidate_needs_review'}
export interface FormulaExplanation extends FormulaBase {kind:'explanation';text:string;sourceRevisionId:string;model?:string;requestId?:string;evidenceIds?:string[];accepted:boolean;stale:boolean}
export interface FormulaHead extends FormulaBase {kind:'head';deletedAt?:number|null;revision:number;sourceRevisionId:string;checkedAt:number|null;eventOrder?:number}
export interface FormulaReview extends FormulaBase {kind:'review';sourceRevisionId:string;checkedAt:number|null;eventOrder:number}
export type FormulaStoredRecord=FormulaSourceRevision|FormulaCandidateRecord|FormulaExplanation|FormulaHead|FormulaReview;
export interface FormulaDocument {deletedAt?:number|null;id:string;docId:string;revision:number;sourceRevisionId:string;latex:string;segments:FormulaSegmentRef[];checkedByUser:boolean;checkedAt:number|null;history:FormulaSourceRevision[];candidates:FormulaCandidateRecord[];explanations:FormulaExplanation[]}
export class FormulaConflictError extends Error {constructor(){super('公式已被其他页面修改，本次未保存；请保留草稿并刷新版本');this.name='FormulaConflictError';}}
export function validateFormulaSegments(segments:readonly FormulaSegmentRef[]):void {
 if(!segments.length||segments.length>8)throw new Error('公式需要1至8个按顺序排列的原图片段');
 for(const segment of segments){if(!segment.assetId||!segment.segmentId||!Number.isInteger(segment.pageIndex)||segment.pageIndex<0||!Number.isInteger(segment.assetVersion)||segment.assetVersion<1||!(segment.cropBlob instanceof Blob)||!segment.cropBlob.size||!segment.hash||segment.quad.length!==4||segment.quad.some(point=>!Number.isFinite(point.x)||!Number.isFinite(point.y))||segment.width<=0||segment.height<=0)throw new Error('公式片段缺少可靠原图、尺寸、哈希或PDF锚点');}
}
export function projectFormula(head:FormulaHead,records:readonly FormulaStoredRecord[]):FormulaDocument {
 const history=records.filter((record):record is FormulaSourceRevision=>record.kind==='source'&&record.formulaId===head.id).sort((a,b)=>a.revision-b.revision);
 const source=history.find(record=>record.id===head.sourceRevisionId);if(!source)throw new Error('公式当前源码修订缺失，原记录未删除');
 return{deletedAt:head.deletedAt,id:head.id,docId:head.docId,revision:head.revision,sourceRevisionId:source.id,latex:source.latex,segments:structuredClone(source.segments),checkedByUser:head.checkedByUser,checkedAt:head.checkedAt,
 history:history.map(source=>{const reviews=records.filter((record):record is FormulaReview=>record.kind==='review'&&record.sourceRevisionId===source.id).sort((a,b)=>a.eventOrder-b.eventOrder);const review=reviews.at(-1);return{...structuredClone(source),...(review?{checkedByUser:review.checkedByUser,checkedAt:review.checkedAt}:{})};}),candidates:records.filter((record):record is FormulaCandidateRecord=>record.kind==='candidate'&&record.formulaId===head.id).map(record=>structuredClone(record)),
 explanations:records.filter((record):record is FormulaExplanation=>record.kind==='explanation'&&record.formulaId===head.id).map(record=>({...structuredClone(record),stale:record.sourceRevisionId!==source.id}))};
}
