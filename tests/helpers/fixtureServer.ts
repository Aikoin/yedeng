/** Local diagnostic assets only. Never imported by the production build. */
export const FIXTURE_FILES = Object.freeze([
  'adversarial-g4.pdf','retention-50mib-g4.pdf',
  'attention.pdf', 'tracemonkey.pdf', 'boundary.pdf', 'boundary-manifest.json', 'password.pdf',
  'formula-complex.pdf', 'formula-complex-manifest.json',
  'formula-evaluation-crosspage.pdf',
] as const);
const allowed = new Set<string>(FIXTURE_FILES);
export function fixtureFileForRequest(rawUrl: string): string | null {
  const path = rawUrl.split('?')[0];
  if (!path.startsWith('/fixtures/')) return null;
  const name = path.slice('/fixtures/'.length);
  return allowed.has(name) ? name : null;
}
