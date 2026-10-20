/** Sanitized, representative v1 records, including duplicate quotes and unsupported extra fields. */
export const migrationFixture: Record<string, Record<string, unknown>[]> = {
  docs: [{ docId: 'paper-one', url: 'https://example.org/one.pdf', title: 'Matrix proof', authors: 'Fixture', numPages: 2, sizeBytes: 13, addedAt: 1, lastOpenedAt: 2, folderId: 'folder-a', favorite: true, stored: true }],
  folders: [{ folderId: 'folder-a', name: 'Legacy folder', createdAt: 1 }],
  blobs: [{ docId: 'paper-one', bytes: new TextEncoder().encode('%PDF-fixture\n').buffer }],
  annotations: [
    { id: 'ann-one', docId: 'paper-one', kind: 'highlight', color: 1, pageIndex: 0, rects: [{ x: .12, y: .21, w: .33, h: .02 }], quote: 'Repeated equation', prefix: '', suffix: '', createdAt: 3, updatedAt: 3, legacyExtra: 'must survive' },
    { id: 'ann-two', docId: 'paper-one', kind: 'note', color: 2, pageIndex: 1, rects: [{ x: .45, y: .51, w: .22, h: .08 }], quote: 'Repeated equation', prefix: '', suffix: '', note: '私有备注 ∫ α', createdAt: 4, updatedAt: 4 },
  ],
  chats: [{ key: 'paper-one:chat', docId: 'paper-one', messages: [{ role: 'user', content: 'What is α?', at: 5 }, { role: 'assistant', content: 'A parameter.', at: 6 }], updatedAt: 6 }],
  cache: [{ key: 'legacy-summary', value: 'Existing summary', createdAt: 7 }],
  usage: [{ date: '2026-10-15', requests: 2, promptTokens: 14, completionTokens: 4 }],
  readingState: [{ docId: 'paper-one', lastPage: 2, zoom: 1.25, updatedAt: 8 }],
};
