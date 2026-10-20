import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotationRecord } from '../src/shared/idb';
import type { SelectionSnapshot } from '../src/pdf/selectionModel';
const mocks = vi.hoisted(() => ({
  state: { docId: 'doc-a', annotations: [] as AnnotationRecord[], viewer: null as { numPages?: number } | null,
    docText: { pages: [{ text: 'Context before selected text context after.' }, { text: 'Second page.' }] }, lastColor: 1 },
  put: vi.fn(), update: vi.fn(), remove: vi.fn(), get: vi.fn(),
  nodes: [] as { tag: string; value: string; listeners: Record<string, (event?: Event) => void> }[],
}));
vi.mock('../src/viewer/state', () => ({ state: mocks.state, jumpToPage: vi.fn() }));
vi.mock('../src/shared/idb', () => ({ idbPut: mocks.put, idbUpdateAnnotation: mocks.update, idbDeleteAnnotation: mocks.remove, idbGetByIndex: mocks.get }));
vi.mock('../src/shared/dom', () => {
  const node = (tag = '', props: Record<string, unknown> = {}) => {
    const element = { tag, value: String(props.value ?? ''), listeners: {} as Record<string, (event?: Event) => void>,
      style: {}, addEventListener(name: string, listener: (event?: Event) => void) { element.listeners[name] = listener; },
      append() {}, appendChild() {}, replaceChildren() {} };
    mocks.nodes.push(element); return element;
  };
  return { h: node, qs: node, clear() {} };
});
vi.mock('../src/shared/toast', () => ({ toast: vi.fn(), toastError: vi.fn(), toastUndo:vi.fn() }));
import { addAnnotation, annotationPages, annotationDisplayRects, recolorAnnotation, deleteAnnotation, loadAnnotations, updateAnnotationNote } from '../src/viewer/annotations';

const quad = [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 10 }, { x: 10, y: 10 }] as const;
const snapshot: SelectionSnapshot = {
  text: 'selected text', pageIndex: 0, firstRect: { left: 0, top: 0, width: 20, height: 10 },
  pageBoxes: [0, 1].map(pageIndex => ({ pageIndex, rects: [{ x: .1, y: .2, w: .3, h: .02 }] })),
  pdfRegions: [0, 1].map(pageIndex => ({ pageIndex, quads: [quad] })),
};
beforeEach(() => {
  mocks.state.docId = 'doc-a'; mocks.state.viewer = null; mocks.state.annotations = []; mocks.put.mockReset(); mocks.update.mockReset(); mocks.remove.mockReset(); mocks.get.mockReset();
  mocks.update.mockImplementation(async (id: string, _docId: string, _revision: number, changes: Partial<AnnotationRecord>) => {
    const current = mocks.state.annotations.find(a => a.id === id)!;
    return { ...current, ...changes, revision: (current.revision ?? 0) + 1 };
  });
  mocks.put.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined); mocks.nodes = [];
});
describe('logical cross-page annotation persistence', () => {
  it('commits one multi-page object with PDF geometry and quote context', async () => {
    const annotation = await addAnnotation('underline', snapshot.pageBoxes, snapshot.text, 2, undefined, snapshot);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(annotation?.kind).toBe('underline');
    expect(annotation?.logicalId).toBe(annotation?.id);
    expect(annotationPages(annotation!)).toEqual([0, 1]);
    expect(annotation?.anchor).toEqual({ coordinateSpace: 'pdf-user-space', status: 'captured', regions: snapshot.pdfRegions });
    expect(annotation?.prefix).toBe('Context before ');
    expect(annotation?.suffix).toContain(' context after.');
    await deleteAnnotation(annotation!.id);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(annotation!.id, 'doc-a', 1);
    expect(mocks.state.annotations).toHaveLength(0);
  });
  it('does not mutate visible state before commit, nor after failed save', async () => {
    let finish!: () => void;
    mocks.put.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = addAnnotation('highlight', snapshot.pageBoxes, snapshot.text, 1, undefined, snapshot);
    expect(mocks.state.annotations).toHaveLength(0);
    finish(); await pending;
    const previous = mocks.state.annotations[0]!;
    mocks.update.mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(updateAnnotationNote(previous.id, 'must not appear saved')).rejects.toThrow('QuotaExceededError');
    expect(mocks.state.annotations[0]).toBe(previous);
    expect(previous.note).toBeUndefined();
    expect(previous.revision).toBe(1);
  });
  it('edits a note once for every page of the logical annotation', async () => {
    const annotation = await addAnnotation('note', snapshot.pageBoxes, snapshot.text, 1, '', snapshot);
    await updateAnnotationNote(annotation!.id, 'Updated note');
    expect(mocks.state.annotations).toHaveLength(1);
    expect(mocks.state.annotations[0]?.note).toBe('Updated note');
    expect(mocks.state.annotations[0]?.revision).toBe(2);
    expect(annotationPages(mocks.state.annotations[0]!)).toEqual([0, 1]);
  });
  it('does not put completed old-document work into the new document state', async () => {
    let finish!: () => void;
    mocks.put.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = addAnnotation('highlight', snapshot.pageBoxes, snapshot.text, 1, undefined, snapshot);
    mocks.state.docId = 'doc-b'; finish(); await pending;
    expect(mocks.state.annotations).toHaveLength(0);
    expect(mocks.put.mock.calls[0]?.[1].docId).toBe('doc-a');
  });
  it('does not guess missing geometry or modify legacy data', async () => {
    await expect(addAnnotation('highlight', snapshot.pageBoxes, snapshot.text, 1)).rejects.toThrow('锚点');
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('drops late old-document loads', async () => {
    let finish!: (records: AnnotationRecord[]) => void;
    mocks.get.mockImplementation(() => new Promise<AnnotationRecord[]>(resolve => { finish = resolve; }));
    const pending = loadAnnotations(); mocks.state.docId = 'doc-b';
    finish([{ id: 'old' } as AnnotationRecord]); await pending;
    expect(mocks.state.annotations).toHaveLength(0);
  });
});


describe('annotation audit regressions', () => {
  it('rejects stale note save/delete rather than reporting a missing record as saved', async () => {
    await expect(updateAnnotationNote('old-document-note', 'not saved')).rejects.toThrow('找不到');
    await expect(deleteAnnotation('old-document-note')).rejects.toThrow('找不到');
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('keeps the full annotation and note visible when delete fails', async () => {
    const record = await addAnnotation('note', snapshot.pageBoxes, snapshot.text, 1, 'must survive', snapshot);
    mocks.remove.mockRejectedValueOnce(new Error('Transaction aborted'));
    await expect(deleteAnnotation(record!.id)).rejects.toThrow('aborted');
    expect(mocks.state.annotations).toEqual([record]);
  });
  it('does not open an old note after the same document was reopened in a new viewer', async () => {
    mocks.state.viewer = { numPages: 0 };
    let finish!: () => void;
    mocks.put.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = addAnnotation('note', snapshot.pageBoxes, snapshot.text, 1, '', snapshot);
    mocks.state.viewer = { numPages: 0 }; finish();
    await expect(pending).resolves.toBeNull();
    expect(mocks.state.annotations).toHaveLength(0);
  });
  it('retains legacy quote, extra fields, original page and rectangles after loading/review', async () => {
    const legacy = { id: 'old', docId: 'doc-a', kind: 'highlight', pageIndex: 1,
      rects: [{ x: .2, y: .3, w: .4, h: .02 }], quote: 'Repeated quote', prefix: '', suffix: '',
      color: 1, createdAt: 1, updatedAt: 1, historyExtra: 'retained' } as AnnotationRecord;
    mocks.get.mockResolvedValueOnce([legacy]); await loadAnnotations();
    expect(mocks.state.annotations[0]).toBe(legacy);
    expect(annotationDisplayRects(legacy, 1, () => { throw new Error('Legacy must not be guessed into PDF space'); },
      { left: 100, top: 200, width: 500, height: 800 })).toEqual(legacy.rects);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('projects each new page from its PDF anchor and never substitutes first-page legacy geometry', async () => {
    const annotation = await addAnnotation('highlight', snapshot.pageBoxes, snapshot.text, 1, undefined, snapshot);
    const layer = { left: 100, top: 200, width: 500, height: 800 };
    expect(annotationDisplayRects(annotation!, 1, () => ({ left: 200, top: 400, width: 150, height: 40 }), layer))
      .toEqual([{ x: .2, y: .25, w: .3, h: .05 }]);
    expect(annotationDisplayRects(annotation!, 1, () => null, layer)).toEqual([]);
    expect(annotationDisplayRects(annotation!, 2, () => { throw new Error('Wrong page'); }, layer)).toEqual([]);
  });
  it('rejects incomplete cross-page geometry without partial writes', async () => {
    const incomplete = { ...snapshot, pdfRegions: snapshot.pdfRegions!.slice(0, 1) };
    await expect(addAnnotation('highlight', snapshot.pageBoxes, snapshot.text, 1, undefined, incomplete)).rejects.toThrow('锚点');
    expect(mocks.put).not.toHaveBeenCalled();
  });
});


describe('deletion/save interleaving', () => {
  it('does not resurrect a note when an old editor saves during deletion', async () => {
    const annotation = await addAnnotation('note', snapshot.pageBoxes, snapshot.text, 1, 'original', snapshot);
    mocks.put.mockClear();
    let finish!: () => void;
    mocks.remove.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const deleting = deleteAnnotation(annotation!.id);
    await expect(updateAnnotationNote(annotation!.id, 'stale draft')).rejects.toThrow('正在删除');
    expect(mocks.put).not.toHaveBeenCalled();
    finish(); await deleting;
    expect(mocks.state.annotations).toHaveLength(0);
    await expect(updateAnnotationNote(annotation!.id, 'still stale')).rejects.toThrow('找不到');
  });
});


describe('unsaved note draft protection', () => {
  it('keeps the editor draft across annotation list refreshes without prematurely persisting it', async () => {
    const annotation = await addAnnotation('note', snapshot.pageBoxes, snapshot.text, 1, 'saved original', snapshot);
    const editor = mocks.nodes.filter(node => node.tag === 'textarea').at(-1)!;
    editor.value = 'unsaved draft'; editor.listeners.input!();
    await recolorAnnotation(annotation!.id, 2);
    expect(mocks.nodes.filter(node => node.tag === 'textarea').at(-1)?.value).toBe('unsaved draft');
    expect(mocks.state.annotations[0]?.note).toBe('saved original');
    await updateAnnotationNote(annotation!.id, 'unsaved draft');
    expect(mocks.state.annotations[0]?.note).toBe('unsaved draft');
  });
});


describe('conflict draft retention', () => {
  it('keeps a rejected draft while refreshing a newer committed version from another tab', async () => {
    const annotation = await addAnnotation('note', snapshot.pageBoxes, snapshot.text, 1, 'baseline', snapshot);
    const conflict = new Error('批注已被其他页面修改，本次未保存'); conflict.name = 'AnnotationConflictError';
    mocks.update.mockRejectedValueOnce(conflict);
    await expect(updateAnnotationNote(annotation!.id, 'my unsaved draft')).rejects.toBe(conflict);
    expect(mocks.state.annotations[0]?.note).toBe('baseline');
    mocks.get.mockResolvedValueOnce([{ ...annotation, note: 'other tab saved', revision: 2 }]);
    await loadAnnotations();
    expect(mocks.state.annotations[0]?.note).toBe('other tab saved');
    expect(mocks.state.annotations[0]?.revision).toBe(2);
    expect(mocks.nodes.filter(node => node.tag === 'textarea').at(-1)?.value).toBe('my unsaved draft');
  });
});
