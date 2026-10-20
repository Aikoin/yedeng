import { expect, it } from 'vitest';
import { fixtureFileForRequest, FIXTURE_FILES } from './helpers/fixtureServer';
it('serves exactly the named local diagnostic fixtures', () => {
  for (const name of FIXTURE_FILES) expect(fixtureFileForRequest(`/fixtures/${name}`)).toBe(name);
  expect(fixtureFileForRequest('/fixtures/boundary.pdf?cache=off')).toBe('boundary.pdf');
});
it('does not decode, normalize or resolve arbitrary paths into fixture filenames', () => {
  for (const url of ['/fixtures/', '/fixtures/../package.json', '/fixtures/%2e%2e/package.json', '/fixtures/%61ttention.pdf',
    '/fixtures/sub/boundary.pdf', '/fixtures/boundary.pdf/../password.pdf', '/fixtures/boundary-manifest.json.bak',
    '/fixtures/attention.pdf#ignored', '/work/fixtures/attention.pdf', '/fixtures/..\\package.json']) {
    expect(fixtureFileForRequest(url)).toBeNull();
  }
});
