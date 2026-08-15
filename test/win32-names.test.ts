import { describe, expect, it } from 'vitest';
import {
  CollisionIndex,
  FilenameIdentityError,
  collisionKey,
  describeWin32Devices,
  isWin32Device,
  measure,
  stripWin32Trailing,
  win32DeviceStem,
} from '../src/index.js';

/** Assembled at runtime so the invisible characters are unmistakable in the source. */
const NBSP = String.fromCodePoint(0x00a0);
const SUPERSCRIPT_ONE = String.fromCodePoint(0x00b9);
const BELL = String.fromCodePoint(0x0007);
const NUL = String.fromCodePoint(0x0000);
const E_ACUTE = String.fromCodePoint(0x00e9);

function refusal(fn: () => unknown): FilenameIdentityError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FilenameIdentityError) return error;
    throw error;
  }
  throw new Error('expected a FilenameIdentityError, but the call returned normally');
}

describe('trailing dots and spaces', () => {
  it('refuses a name Win32 will shorten before the volume sees it', () => {
    const error = refusal(() => collisionKey('report. ', 'ntfs'));
    expect(error.code).toBe('trailing-strip');
    expect(error.profile).toBe('ntfs');
  });

  it('names the file that would actually be written', () => {
    const error = refusal(() => collisionKey('report. ', 'ntfs'));
    expect(error.message).toContain('"report"');
    expect(error.message).toContain('U+002E U+0020');
  });

  it('is invisible to a Set of raw strings, which is the whole problem', () => {
    const naive = new Set(['report']);
    expect(naive.has('report. ')).toBe(false);

    const index = new CollisionIndex({ profiles: ['ntfs'] });
    index.add('report');
    expect(() => index.add('report. ')).toThrow(FilenameIdentityError);
  });

  it('refuses a single trailing dot', () => {
    expect(refusal(() => collisionKey('report.', 'ntfs')).code).toBe('trailing-strip');
  });

  it('refuses a run of trailing dots and reports the surviving stem', () => {
    const error = refusal(() => collisionKey('report...', 'ntfs'));
    expect(error.message).toContain('"report"');
    expect(error.message).toContain('3 characters');
  });

  it('reports that a name made only of dots and spaces reduces to nothing', () => {
    const error = refusal(() => collisionKey('... ', 'ntfs'));
    expect(error.code).toBe('trailing-strip');
    expect(error.message).toContain('reduces to nothing');
  });

  it('warns when the surviving stem is also a device', () => {
    const error = refusal(() => collisionKey('CON. ', 'ntfs'));
    expect(error.code).toBe('trailing-strip');
    expect(error.message).toContain('reserved device');
  });

  it('accepts the same name on a byte comparing target and keys it distinctly', () => {
    expect(collisionKey('report. ', 'ext4')).not.toBe(collisionKey('report', 'ext4'));
  });

  it('does not strip a no break space, because Win32 does not either', () => {
    const name = `report${NBSP}`;
    expect(stripWin32Trailing(name)).toBe(name);
    expect(collisionKey(name, 'ntfs')).not.toBe(collisionKey('report', 'ntfs'));
  });

  it('leaves leading spaces alone', () => {
    expect(collisionKey(' report.txt', 'ntfs')).toBe('ntfs/ REPORT.TXT');
  });

  it('strips only from the end of the component', () => {
    expect(stripWin32Trailing('a. .b. ')).toBe('a. .b');
    expect(stripWin32Trailing('plain.txt')).toBe('plain.txt');
    expect(stripWin32Trailing('   ')).toBe('');
  });
});

describe('reserved device names', () => {
  it('refuses CON.txt, because the extension is not part of the comparison', () => {
    const error = refusal(() => collisionKey('CON.txt', 'ntfs'));
    expect(error.code).toBe('reserved-device');
    expect(error.message).toContain('"CON"');
  });

  it('refuses a lowercase device name', () => {
    expect(refusal(() => collisionKey('nul.log', 'ntfs')).code).toBe('reserved-device');
  });

  it('refuses a bare device name with no extension', () => {
    expect(refusal(() => collisionKey('AUX', 'ntfs')).code).toBe('reserved-device');
  });

  it('refuses a device name followed by several extensions', () => {
    expect(refusal(() => collisionKey('prn.tar.gz', 'ntfs')).code).toBe('reserved-device');
  });

  it('refuses a device name with spaces before the dot', () => {
    expect(refusal(() => collisionKey('CON .txt', 'ntfs')).code).toBe('reserved-device');
  });

  it('refuses the superscript port numbers Win32 accepts', () => {
    expect(refusal(() => collisionKey(`COM${SUPERSCRIPT_ONE}.dat`, 'ntfs')).code).toBe(
      'reserved-device',
    );
  });

  it('refuses the console handles added after the original set', () => {
    expect(refusal(() => collisionKey('CONIN$.txt', 'ntfs')).code).toBe('reserved-device');
  });

  it('accepts names that merely start with a device name', () => {
    expect(() => collisionKey('CONS.txt', 'ntfs')).not.toThrow();
    expect(() => collisionKey('COM0.txt', 'ntfs')).not.toThrow();
    expect(() => collisionKey('COM10.txt', 'ntfs')).not.toThrow();
  });

  it('accepts a dotfile, whose stem before the first dot is empty', () => {
    expect(() => collisionKey('.gitignore', 'ntfs')).not.toThrow();
    expect(win32DeviceStem('.gitignore')).toBe('');
  });

  it('accepts a device name on a target that has no device namespace', () => {
    expect(collisionKey('CON.txt', 'ext4')).toBe('ext4/CON.txt');
  });

  it('exposes the device test and the device list', () => {
    expect(isWin32Device('con.txt')).toBe(true);
    expect(isWin32Device('contract.txt')).toBe(false);
    expect(describeWin32Devices()).toContain('CON');
  });
});

describe('alternate data streams', () => {
  it('refuses a colon and names the file the write would really land on', () => {
    const error = refusal(() => collisionKey('notes.txt:tag', 'ntfs'));
    expect(error.code).toBe('alternate-data-stream');
    expect(error.message).toContain('"notes.txt"');
  });

  it('refuses a leading colon, which targets the directory itself', () => {
    const error = refusal(() => collisionKey(':tag', 'ntfs'));
    expect(error.code).toBe('alternate-data-stream');
    expect(error.message).toContain('containing directory');
  });

  it('refuses the explicit default stream suffix', () => {
    expect(refusal(() => collisionKey('notes.txt::$DATA', 'ntfs')).code).toBe(
      'alternate-data-stream',
    );
  });

  it('accepts a colon on ext4, where it is an ordinary character', () => {
    expect(() => collisionKey('notes.txt:tag', 'ext4')).not.toThrow();
  });
});

describe('characters the targets disagree about', () => {
  it('refuses a backslash on Windows and keeps it on ext4', () => {
    expect(refusal(() => collisionKey('a\\b.txt', 'ntfs')).code).toBe('path-separator');
    expect(collisionKey('a\\b.txt', 'ext4')).toBe('ext4/a\\b.txt');
  });

  it('refuses a forward slash everywhere', () => {
    expect(refusal(() => collisionKey('a/b.txt', 'ext4')).code).toBe('path-separator');
    expect(refusal(() => collisionKey('a/b.txt', 'apfs')).code).toBe('path-separator');
  });

  it('refuses the Windows wildcard and redirection characters', () => {
    expect(refusal(() => collisionKey('a<b.txt', 'ntfs')).code).toBe('forbidden-character');
    expect(refusal(() => collisionKey('what?.txt', 'ntfs')).code).toBe('forbidden-character');
    expect(() => collisionKey('what?.txt', 'ext4')).not.toThrow();
  });

  it('refuses a control character on Windows and keeps it on ext4', () => {
    expect(refusal(() => collisionKey(`a${BELL}b.txt`, 'ntfs')).code).toBe('control-character');
    expect(() => collisionKey(`a${BELL}b.txt`, 'ext4')).not.toThrow();
  });

  it('refuses NUL on every target, since the name would be truncated at it', () => {
    const error = refusal(() => collisionKey(`a${NUL}b.txt`, 'ext4'));
    expect(error.code).toBe('nul-byte');
    expect(error.message).toContain('truncated');
  });

  it('refuses the directory traversal names', () => {
    expect(refusal(() => collisionKey('.', 'ext4')).code).toBe('dot-segment');
    expect(refusal(() => collisionKey('..', 'apfs')).code).toBe('dot-segment');
  });

  it('accepts a name that is three dots on a target with no Win32 layer', () => {
    expect(() => collisionKey('...', 'ext4')).not.toThrow();
  });

  it('refuses the empty string and non strings', () => {
    expect(refusal(() => collisionKey('', 'ext4')).code).toBe('empty-name');
    expect(refusal(() => collisionKey(undefined as unknown as string, 'ext4')).code).toBe(
      'empty-name',
    );
  });
});

describe('length limits', () => {
  it('accepts a name at the limit and refuses one past it', () => {
    expect(() => collisionKey('a'.repeat(255), 'ntfs')).not.toThrow();
    expect(refusal(() => collisionKey('a'.repeat(256), 'ntfs')).code).toBe('name-too-long');
    expect(refusal(() => collisionKey('a'.repeat(256), 'ext4')).code).toBe('name-too-long');
  });

  it('measures the stored form, which grows when the volume decomposes on write', () => {
    const name = E_ACUTE.repeat(100);
    expect(measure(name, 'utf8-bytes')).toBe(200);
    expect(() => collisionKey(name, 'ext4')).not.toThrow();

    const error = refusal(() => collisionKey(name, 'apfs'));
    expect(error.code).toBe('name-too-long');
    expect(error.message).toContain('grows on write');
  });

  it('counts UTF-16 code units and UTF-8 bytes separately', () => {
    expect(measure('\u{1F600}', 'utf16-code-units')).toBe(2);
    expect(measure('\u{1F600}', 'utf8-bytes')).toBe(4);
  });

  it('agrees with a real encoder across every byte width', () => {
    const encoder = new TextEncoder();
    for (const sample of ['a', 'é', '中', '\u{1F600}', `caf${E_ACUTE}`, `e${String.fromCodePoint(0x0301)}`, 'ΑΒΓ', '']) {
      expect(measure(sample, 'utf8-bytes')).toBe(encoder.encode(sample).length);
    }
  });
});
