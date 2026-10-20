import {ensureImportRecord} from './importRecord';
import{safeRasterThumbnail}from'../shared/messageGuard';
import{savePdfLocally,pdfRetentionStatus,previewDocumentRemoval,removeDocument,prepareByteDedup,commitByteDedup,type DedupPlan}from'../storage/documents';
import{exportPortableDocument}from'../storage/portableExport';
/** 简版文献库：最近阅读 / 收藏 / 全部 / 单层文件夹 / 搜索 / 删除 */
import { clear as clearHost, h, qs } from '../shared/dom';
import { setLang } from '../shared/i18n';
import { idbDelete, idbGet, idbGetAll, idbPut, idbPatchDocRecord, type DocRecord, type FolderRecord } from '../shared/idb';
import { sha256Hex } from '../shared/hash';
import { viewerUrl } from '../shared/messaging';
import { loadSettings } from '../shared/settings';
import { toast, toastError } from '../shared/toast';

type View = 'recent' | 'favorites' | 'all' | `folder:${string}`;

let docs: DocRecord[] = [];
let folders: FolderRecord[] = [];
let view: View = 'recent';
let query = '';
const retention=new Map<string,string>();
let dedupPlan:DedupPlan|null=null;

async function init(): Promise<void> {
  const settings = await loadSettings();
  setLang(settings.ui.lang);
  document.documentElement.dataset.theme = settings.ui.theme;

  qs('#search').addEventListener('input', (event) => {
    query = (event.target as HTMLInputElement).value.trim().toLowerCase();
    render();
  });
  qs('#btn-new-folder').addEventListener('click', () => void createFolder());
  qs('#btn-settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());

  const picker=h('input',{type:'file',accept:'.pdf,application/pdf',hidden:true});document.body.append(picker);
  qs('#btn-import-pdf').onclick=()=>picker.click();picker.onchange=()=>{const file=picker.files?.[0];if(file)void importPdf(file).finally(()=>{picker.value='';});};
  const showManage=()=>{qs('#manage-panel').hidden=location.hash!=='#manage';};
  qs('#btn-manage').onclick=()=>{location.hash='manage';showManage();qs('#btn-dedup').focus();};
  qs('#btn-manage-close').onclick=()=>{history.replaceState(null,'',location.pathname);showManage();qs('#btn-manage').focus();};window.addEventListener('hashchange',showManage);showManage();
  qs('#btn-dedup').addEventListener('click',()=>void previewDedup());
  qs('#btn-dedup-confirm').addEventListener('click',()=>void confirmDedup());
  await reload();
}

async function reload(): Promise<void> {
  [docs, folders] = await Promise.all([idbGetAll('docs'), idbGetAll('folders')]);
  retention.clear();
  for(const doc of docs)retention.set(doc.docId,await pdfRetentionStatus(doc.docId));
  render();
}

function visibleDocs(): DocRecord[] {
  let list = [...docs];
  if (view === 'recent') list.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  else if (view === 'favorites') list = list.filter((d) => d.favorite).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  else if (view === 'all') list.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  else {
    const folderId = view.slice('folder:'.length);
    list = list.filter((d) => d.folderId === folderId).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
  if (query) {
    list = list.filter(
      (d) => d.title.toLowerCase().includes(query) || d.authors.toLowerCase().includes(query)
    );
  }
  return list;
}

function render(): void {
  renderFolders();
  const grid = qs('#grid');
  clearHost(grid);
  const list = visibleDocs();
  qs('#document-count').textContent=`${list.length} 篇文献`;qs('#view-title').textContent=query?'搜索结果':view==='recent'?'最近阅读':view==='favorites'?'我的收藏':view==='all'?'全部文献':folders.find(folder=>folder.folderId===view.slice(7))?.name??'文件夹';
  if (list.length === 0) {
    grid.appendChild(
      h(
        'div',
        { class: 'empty' },
        query?'没有找到匹配的文献。\n试试标题中的其他词，或清空搜索。':'从一份论文开始。\n点击“导入 PDF”，文献与阅读记录会留在这里。'
      )
    );
    return;
  }
  for (const doc of list) grid.appendChild(docCard(doc));
}

function renderFolders(): void {
  const host = qs('#folders');
  clearHost(host);
  const item = (label: string, target: View, count: number) => {
    const button = h('button', { class: view === target ? 'is-active' : '' }, `${label}（${count}）`);
    button.addEventListener('click', () => {
      view = target;
      render();
    });
    return button;
  };
  host.append(
    item('最近阅读', 'recent', docs.length),
    item('收藏', 'favorites', docs.filter((d) => d.favorite).length),
    item('全部', 'all', docs.length),
    h('div', { class: 'folders__title' }, '文件夹')
  );
  for (const folder of folders) {
    const button = h(
      'button',
      { class: view === `folder:${folder.folderId}` ? 'is-active' : '' },
      `📁 ${folder.name}（${docs.filter((d) => d.folderId === folder.folderId).length}）`
    );
    button.addEventListener('click', () => {
      view = `folder:${folder.folderId}`;
      render();
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void removeFolder(folder);
    });
    host.appendChild(button);
  }
}

function docCard(doc: DocRecord): HTMLElement {
  const card = h('div', { class: 'doc' });
  const thumb = h('button', { class: 'doc__thumb', 'aria-label':`继续阅读：${doc.title}` });
  if (safeRasterThumbnail(doc.thumb)) {
    thumb.appendChild(h('img', { src: doc.thumb, alt: doc.title }));
  } else {
    thumb.appendChild(h('span', { class: 'doc__meta' }, 'PDF'));
  }
  thumb.addEventListener('click', () => void openDoc(doc));

  const body = h(
    'div',
    { class: 'doc__body' },
    h('div', { class: 'doc__title' }, (doc.favorite ? '★ ' : '') + doc.title),
    h(
      'div',
      { class: 'doc__meta' },
      [
        retention.get(doc.docId)==='stored'?'已保存在本机':retention.get(doc.docId)==='corrupt'?'文件需要重新导入':'需原文件或联网打开',
        doc.authors.slice(0, 40),
        doc.numPages?`${doc.numPages} 页`:'待打开读取',
        new Date(doc.lastOpenedAt).toLocaleDateString(),
      ]
        .filter(Boolean)
        .join(' · ')
    )
  );

  const actions = h('div', { class: 'doc__actions' });
  actions.appendChild(h('button', { on: { click: () => void openDoc(doc) } }, '继续阅读'));
  actions.appendChild(
    h(
      'button',
      {
        on: {
          click: async () => {
            try {
              const updated = await idbPatchDocRecord(doc.docId, { favorite: !doc.favorite });
              Object.assign(doc, updated); render();
            } catch (error) { toastError(error); }
          },
        },
      },
      doc.favorite ? '取消收藏' : '收藏'
    )
  );

  const folderSelect = h('select',{'aria-label':`移动《${doc.title}》到文件夹`}) as HTMLSelectElement;
  folderSelect.appendChild(h('option', { value: '' }, '未分类'));
  for (const folder of folders) folderSelect.appendChild(h('option', { value: folder.folderId }, folder.name));
  folderSelect.value = doc.folderId ?? '';
  folderSelect.addEventListener('change', async () => {
    try {
      const updated = await idbPatchDocRecord(doc.docId, { folderId: folderSelect.value || null });
      Object.assign(doc, updated); render();
    } catch (error) { folderSelect.value = doc.folderId ?? ''; toastError(error); }
  });
  actions.appendChild(folderSelect);

  actions.appendChild(
    h(
      'button',
      {
        class: 'danger',
        on: {
          click: async () => {
            try{const preview=await previewDocumentRemoval(doc.docId);
            if(preview.activeTasks){toast('请先取消此文献的未结束任务或关闭阅读器后重试','error');return;}
            if(!window.confirm(`移除《${doc.title}》？将删除本地PDF、批注、原图、公式历史及已保存结果。范围：${Object.entries(preview.counts).map(([key,count])=>`${({docs:'文献',blobs:'PDF 文件',annotations:'批注',regions:'图表与公式原图',formulaRevisions:'公式编辑记录',chats:'对话',tasks:'已保存结果',readingState:'阅读位置',cache:'AI 结果'} as Record<string,string>)[key]??'相关记录'} ${count}`).join('、')}。请求次数和用量保留，其他文献不删除。请先备份；此操作不能撤销。`))return;
            await removeDocument(doc.docId);
            toast('已移除', 'success', 1200);
            await reload();}catch(error){toastError(error);}
          },
        },
      },
      '移除'
    )
  );

  actions.append(h('button',{on:{click:()=>void exportPortableDocument(doc.docId).then(()=>toast('阅读包已生成，请确认下载完成','success')).catch(toastError)}},'导出笔记'));
  card.append(thumb, body, actions);
  return card;
}

async function openDoc(doc: DocRecord): Promise<void> {
  // 有本地副本就离线打开：既更快，也绕开付费墙站点的 Cookie 限制
  const blob = await idbGet('blobs', doc.docId);
  if (blob) {
    window.open(chrome.runtime.getURL(`viewer/index.html?doc=${doc.docId}`), '_blank');
    return;
  }
  if (doc.url) {
    window.open(viewerUrl(doc.url), '_blank');
    return;
  }
  toast('这是本地文件且没有留存副本，请重新拖入阅读器', 'error', 3000);
}

async function createFolder(): Promise<void> {
  const name = window.prompt('文件夹名称');
  if (!name?.trim()) return;
  await idbPut('folders', { folderId: crypto.randomUUID(), name: name.trim(), createdAt: Date.now() });
  await reload();
}

async function removeFolder(folder: FolderRecord): Promise<void> {
  if (!window.confirm(`删除文件夹「${folder.name}」？（里面的文献会被移到"未分类"）`)) return;
  for (const doc of docs.filter((d) => d.folderId === folder.folderId)) {
    const updated = await idbPatchDocRecord(doc.docId, { folderId: null });
    Object.assign(doc, updated);
  }
  await idbDelete('folders', folder.folderId);
  await reload();
}

void init();

async function previewDedup():Promise<void>{try{dedupPlan=await prepareByteDedup();qs('#dedup-preview').textContent=dedupPlan.groups.length?dedupPlan.groups.map(g=>`${g.docIds.map(id=>(docs.find(d=>d.docId===id)?.title??'文献')).join('、')}：相同文件 ${g.docIds.length} 份 → 1 份；保留 ${g.sources.length} 个来源与全部批注。`).join('\n')+'\n请先下载完整备份。确认后将合并重复文件，主条目标题和分类保留，任一收藏保留，最新阅读位置优先，所有置顶保留。请求次数和用量记录保留。':'没有发现完全相同的文件。标题相同的不同论文不会被合并。';qs<HTMLButtonElement>('#btn-dedup-confirm').disabled=!dedupPlan.groups.length;}catch(error){toastError(error);}}
async function confirmDedup():Promise<void>{if(!dedupPlan)return;const button=qs<HTMLButtonElement>('#btn-dedup-confirm');button.disabled=true;try{await commitByteDedup(dedupPlan);dedupPlan=null;qs('#dedup-preview').textContent='重复文件已合并，批注与原图保留。';await reload();}catch(error){toastError(error);qs('#dedup-preview').textContent='合并未完成，没有移除文件。请重新检查后再试。';}}

async function importPdf(file:File):Promise<void>{
 const button=qs<HTMLButtonElement>('#btn-import-pdf');button.disabled=true;button.textContent='正在导入…';
 try{const bytes=await file.arrayBuffer();if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('这份文件不是可识别的 PDF，请重新选择。');
  const docId=`b:${await sha256Hex(bytes)}`,existing=await ensureImportRecord(docId,file);
  await savePdfLocally(docId,bytes);await reload();toast(existing?'已找到这份文献，继续上次阅读':'PDF 已保存，正在打开','success');
  await chrome.tabs.create({url:chrome.runtime.getURL(`viewer/index.html?doc=${encodeURIComponent(docId)}`)});
 }catch(error){toastError(error);}finally{button.disabled=false;button.textContent='＋ 导入 PDF';}
}

