import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  formatScriptSource,
  isUpdateAvailable,
  parseScriptSource,
  scriptSourceApiUrl,
  scriptSourceWebUrl,
} from './scriptSource.js';

describe('parseScriptSource (#5255)', () => {
  it('parses a plain owner/repo/path', () => {
    expect(parseScriptSource('Yeraze/meshmonitor/examples/auto-responder-scripts/hello.js')).toEqual({
      owner: 'Yeraze',
      repo: 'meshmonitor',
      path: 'examples/auto-responder-scripts/hello.js',
    });
  });

  it('parses a github.com blob URL, keeping the branch', () => {
    expect(parseScriptSource('https://github.com/kd2abc/scripts/blob/dev/weather.py')).toEqual({
      owner: 'kd2abc',
      repo: 'scripts',
      path: 'weather.py',
      ref: 'dev',
    });
  });

  it('parses a raw.githubusercontent URL, taking its branch as the ref', () => {
    // The branch sits where `blob/<ref>` would be in a web URL. Leaving it on
    // the front of the path would make every raw URL 404.
    expect(parseScriptSource('https://raw.githubusercontent.com/kd2abc/scripts/main/dir/weather.py')).toEqual({
      owner: 'kd2abc',
      repo: 'scripts',
      path: 'dir/weather.py',
      ref: 'main',
    });
    expect(parseScriptSource('https://raw.githubusercontent.com/kd2abc/scripts/weather.py')).toBeNull();
  });

  it('rejects anything that could point somewhere else', () => {
    for (const bad of [
      'http://evil.test/payload.py',
      'file:///etc/passwd',
      'owner/repo/../../etc/passwd',
      'owner/repo',
      'owner//script.py',
      '../../script.py',
      'ow ner/repo/script.py',
      '',
      null,
      42,
    ]) {
      expect(parseScriptSource(bad as unknown)).toBeNull();
    }
  });
});

describe('script source URLs (#5255)', () => {
  const source = { owner: 'kd2abc', repo: 'scripts', path: 'dir/weather.py' };

  it('builds a Contents API URL, letting GitHub pick the default branch', () => {
    expect(scriptSourceApiUrl(source)).toBe(
      'https://api.github.com/repos/kd2abc/scripts/contents/dir/weather.py'
    );
  });

  it('pins the ref when the source names one', () => {
    expect(scriptSourceApiUrl({ ...source, ref: 'dev' })).toBe(
      'https://api.github.com/repos/kd2abc/scripts/contents/dir/weather.py?ref=dev'
    );
  });

  it('links to the file for a human', () => {
    expect(scriptSourceWebUrl(source)).toBe('https://github.com/kd2abc/scripts/blob/HEAD/dir/weather.py');
    expect(formatScriptSource(source)).toBe('kd2abc/scripts/dir/weather.py');
  });
});

describe('compareVersions (#5255)', () => {
  it('orders numeric versions', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v1.3', '1.3')).toBe(0);
  });

  it('sorts a pre-release before its release', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0-beta.1', '1.2.0-beta.2')).toBeLessThan(0);
  });

  it('compares numeric pre-release parts as numbers, not text', () => {
    expect(compareVersions('1.2.0-beta.9', '1.2.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.2.0-beta', '1.2.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('1.2.0-alpha.1', '1.2.0-beta.1')).toBeLessThan(0);
  });

  it('treats unparseable versions as equal, so nothing claims an update', () => {
    expect(compareVersions('nightly', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', 'unknown')).toBe(0);
  });
});

describe('isUpdateAvailable (#5255)', () => {
  it('only reports an update for a strictly newer version', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true);
    expect(isUpdateAvailable('1.0.1', '1.0.1')).toBe(false);
    expect(isUpdateAvailable('2.0.0', '1.0.0')).toBe(false);
  });

  it('says no when either side is missing', () => {
    expect(isUpdateAvailable(null, '1.0.0')).toBe(false);
    expect(isUpdateAvailable('1.0.0', undefined)).toBe(false);
  });
});
