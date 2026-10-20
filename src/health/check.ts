/** No model calls, settings reads, private papers or permission changes. */
export interface InstallationMarker { pageInstance: string; at: number; version: string }
export interface CheckItem { id: string; label: string; status: 'pass' | 'fail' | 'info'; detail: string }
export interface InstallationReport {
  schema: 1; at: string; extensionId: string; version: string; nativeExtension: boolean;
  userAgent: string; state: 'blocked' | 'needs_reopen' | 'ready_for_manual';
  checks: CheckItem[]; previousPageRecovered: boolean; realModelRequests: 0;
}
export interface InstallationCheckDeps {
  protocol: string; originHost: string; extensionId: string; version: string; userAgent: string; pageInstance: string;
  readMarker(): Promise<InstallationMarker | null>; writeMarker(value: InstallationMarker): Promise<void>;
  readPermissions(): Promise<{ permissions?: string[]; origins?: string[] }>;
  fileAccess(): Promise<boolean>; background(): Promise<{ extensionId?: string; version?: string } | undefined>;
  checkAssets(): Promise<boolean>; checkDatabase(): Promise<boolean>;
}
export async function runInstallationCheck(d: InstallationCheckDeps): Promise<InstallationReport> {
  const nativeExtension = d.protocol === 'chrome-extension:' && d.originHost === d.extensionId && /^[a-p]{32}$/.test(d.extensionId);
  const report: InstallationReport = { schema: 1, at: new Date().toISOString(), extensionId: d.extensionId, version: d.version,
    nativeExtension, userAgent: d.userAgent, state: 'blocked', checks: [], previousPageRecovered: false, realModelRequests: 0 };
  const add = (id: string, label: string, pass: boolean, detail: string) => report.checks.push({ id, label, status: pass ? 'pass' : 'fail', detail });
  add('native', '真实 Chrome 扩展环境', nativeExtension, nativeExtension ? '扩展身份与页面来源匹配检查格式' : '网页或模拟环境不能签为真实 Chrome 验收');
  // Do not read even diagnostic persistent state when opened in a web preview.
  if (!nativeExtension) return report;
  const check = async (id: string, label: string, operation: () => Promise<boolean>, detail: string) => {
    try { add(id, label, await operation(), detail); } catch { add(id, label, false, '本项检查失败；不读取或导出错误中的私密信息，请重试本机检查'); }
  };
  await check('background', '后台服务连接', async () => { const value = await d.background(); return value?.extensionId === d.extensionId && value?.version === d.version; }, '仅核对本扩展身份与版本，不读取配置');
  await check('assets', '阅读器与品牌资源', d.checkAssets, '阅读器、模型设置、文献库与图标均为扩展内置文件');
  await check('database', '独立测试库读写', d.checkDatabase, '独立测试库关闭后重开核对；不读取或修改论文库');
  await check('permissions', '当前权限可读取', async () => {
    const value = await d.readPermissions();
    report.checks.push({ id: 'host-access', label: '网页访问范围', status: 'info', detail: `已授予 ${value.permissions?.length ?? 0} 项 API 权限、${value.origins?.length ?? 0} 条站点规则。这里只统计，不导出站点列表、不申请权限。` });
    return Array.isArray(value.permissions);
  }, '读取现有权限，不申请、扩大或移除权限');
  try { const allowed = await d.fileAccess(); report.checks.push({ id: 'file-access', label: '文件网址接管', status: 'info', detail: allowed ? '已开启。仍需用自己的测试 PDF 验证接管。' : '未开启。可继续使用阅读器里的“打开 PDF”文件选择入口；不自动改开关。' }); }
  catch { report.checks.push({ id: 'file-access', label: '文件网址接管', status: 'info', detail: '无法读取此开关；请在 Chrome 扩展详情查看。' }); }
  await check('storage', '安装检查记录保存', async () => {
    const previous = await d.readMarker();
    report.previousPageRecovered = !!previous && previous.pageInstance !== d.pageInstance && previous.version === d.version;
    const value = { pageInstance: d.pageInstance, at: Date.now(), version: d.version };
    await d.writeMarker(value); const restored = await d.readMarker();
    return restored?.pageInstance === value.pageInstance && restored.at === value.at;
  }, '仅存一条无私密内容的检查记录；关闭此页再打开可验证重开恢复');
  if (!report.checks.some(c => c.status === 'fail')) report.state = report.previousPageRecovered ? 'ready_for_manual' : 'needs_reopen';
  return report;
}
