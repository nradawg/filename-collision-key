import { describe, expect, it } from 'vitest';
import {
  FilenameIdentityError,
  collisionKey,
  collisionKeys,
  comparePair,
  contestedReason,
  hfsPlusDecompose,
  ntfsUpcase,
  unicodeFold,
} from '../src/index.js';

const KELVIN = String.fromCodePoint(0x212a);
const ANGSTROM = String.fromCodePoint(0x212b);
const A_RING = String.fromCodePoint(0x00c5);
const DOTLESS_I = String.fromCodePoint(0x0131);
const DOTTED_I = String.fromCodePoint(0x0130);
const SHARP_S = String.fromCodePoint(0x00df);
const FINAL_SIGMA = String.fromCodePoint(0x03c2);
const MICRO_SIGN = String.fromCodePoint(0x00b5);
const LONG_S = String.fromCodePoint(0x017f);
const CHEROKEE_A = String.fromCodePoint(0x13a0);
const FFI = String.fromCodePoint(0xfb03);
const DESERET_UPPER = String.fromCodePoint(0x10400);
const DESERET_LOWER = String.fromCodePoint(0x10428);
const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const COMBINING_CEDILLA = String.fromCodePoint(0x0327);
const COMBINING_DOT_ABOVE = String.fromCodePoint(0x0307);

function refusal(fn: () => unknown): FilenameIdentityError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FilenameIdentityError) return error;
    throw error;
  }
  throw new Error('expected a FilenameIdentityError, but the call returned normally');
}

describe('ordinary case folding', () => {
  it('merges an ASCII case pair on the folding targets and keeps it on ext4', () => {
    expect(collisionKey('A.txt', 'ntfs')).toBe(collisionKey('a.txt', 'ntfs'));
    expect(collisionKey('A.txt', 'apfs')).toBe(collisionKey('a.txt', 'apfs'));
    expect(collisionKey('A.txt', 'ext4')).not.toBe(collisionKey('a.txt', 'ext4'));
  });

  it('keeps case for a case sensitive APFS volume while still folding normalization', () => {
    expect(collisionKey('A.txt', 'apfs-case-sensitive')).not.toBe(
      collisionKey('a.txt', 'apfs-case-sensitive'),
    );
    expect(collisionKey(`cafe${COMBINING_ACUTE}.txt`, 'apfs-case-sensitive')).toBe(
      collisionKey('café.txt', 'apfs-case-sensitive'),
    );
  });

  it('namespaces the key by profile, so keys from two targets never compare equal', () => {
    expect(collisionKey('a.txt', 'ext4')).not.toBe(collisionKey('a.txt', 'apfs'));
    expect(collisionKey('a.txt', 'ntfs').startsWith('ntfs/')).toBe(true);
  });
});

describe('the Kelvin sign, where lowercasing merges what NTFS keeps apart', () => {
  const kelvin = `${KELVIN}elvin.txt`;

  it('is merged by the naive key', () => {
    expect(kelvin.toLowerCase()).toBe('kelvin.txt');
  });

  it('is two separate files on NTFS, because its table only uppercases', () => {
    expect(collisionKey(kelvin, 'ntfs')).not.toBe(collisionKey('kelvin.txt', 'ntfs'));
  });

  it('is one file on APFS, which reaches it through normalization', () => {
    expect(collisionKey(kelvin, 'apfs')).toBe(collisionKey('kelvin.txt', 'apfs'));
  });

  it('reports the disagreement rather than picking a side', () => {
    const comparison = comparePair(kelvin, 'kelvin.txt', ['ntfs', 'apfs', 'ext4']);
    expect(comparison.collidesOn).toEqual(['apfs']);
    expect(comparison.distinctOn).toEqual(['ntfs', 'ext4']);
    expect(comparison.reason.length).toBeGreaterThan(0);
  });
});

describe('the dotless i, where lowercasing splits what NTFS merges', () => {
  it('is left alone by lowercasing but uppercases to plain I', () => {
    expect(DOTLESS_I.toLowerCase()).not.toBe('i');
    expect(DOTLESS_I.toUpperCase()).toBe('I');
  });

  it('is refused by every folding target rather than guessed at', () => {
    expect(refusal(() => collisionKey(`${DOTLESS_I}.txt`, 'ntfs')).code).toBe('contested-fold');
    expect(refusal(() => collisionKey(`${DOTLESS_I}.txt`, 'apfs')).code).toBe('contested-fold');
  });

  it('is accepted on a target that folds nothing', () => {
    expect(() => collisionKey(`${DOTLESS_I}.txt`, 'ext4')).not.toThrow();
  });

  it('says which code point is at fault and what to do', () => {
    const error = refusal(() => collisionKey(`${DOTLESS_I}.txt`, 'ntfs'));
    expect(error.codePoint).toBe(0x0131);
    expect(error.message).toContain('U+0131');
    expect(error.message).toContain('ext4');
  });
});

describe('contested characters', () => {
  it('refuses the dotted capital I, whose lowercase is two code points', () => {
    expect(refusal(() => collisionKey(`${DOTTED_I}.txt`, 'apfs')).code).toBe('contested-fold');
  });

  it('catches the dotted capital I before normalization can hide it', () => {
    // NFD turns it into an ordinary I plus a combining dot, neither of
    // which is contested on its own, so a scan of the normalized form
    // would let it through.
    expect(DOTTED_I.normalize('NFD')).toBe(`I${COMBINING_DOT_ABOVE}`);
    expect(refusal(() => collisionKey(`${DOTTED_I}.txt`, 'hfs-plus')).code).toBe('contested-fold');
  });

  it('refuses sharp s in both of its spellings', () => {
    expect(refusal(() => collisionKey(`stra${SHARP_S}e.txt`, 'apfs')).code).toBe('contested-fold');
    expect(refusal(() => collisionKey('ẞ.txt', 'ntfs')).code).toBe('contested-fold');
  });

  it('refuses final sigma, the micro sign and the long s', () => {
    expect(refusal(() => collisionKey(`${FINAL_SIGMA}.txt`, 'apfs')).code).toBe('contested-fold');
    expect(refusal(() => collisionKey(`${MICRO_SIGN}m.txt`, 'apfs')).code).toBe('contested-fold');
    expect(refusal(() => collisionKey(`${LONG_S}um.txt`, 'apfs')).code).toBe('contested-fold');
  });

  it('refuses scripts whose case mappings postdate older volume tables', () => {
    expect(refusal(() => collisionKey(`${CHEROKEE_A}.txt`, 'apfs')).code).toBe('contested-fold');
    expect(refusal(() => collisionKey('Ა.txt', 'apfs')).code).toBe('contested-fold');
  });

  it('refuses a ligature on NTFS, whose fixed width table cannot hold an expansion', () => {
    const error = refusal(() => collisionKey(`${FFI}le.txt`, 'ntfs'));
    expect(error.code).toBe('contested-fold');
    expect(error.message).toContain('3 code points');
  });

  it('accepts that same ligature on APFS, where lowercasing it is a no op', () => {
    expect(() => collisionKey(`${FFI}le.txt`, 'apfs')).not.toThrow();
  });

  it('lets byte comparing targets keep every contested character', () => {
    for (const name of [DOTTED_I, DOTLESS_I, SHARP_S, FINAL_SIGMA, CHEROKEE_A]) {
      expect(() => collisionKey(`${name}.txt`, 'ext4')).not.toThrow();
    }
  });

  it('reports a reason for contested code points and nothing for ordinary ones', () => {
    expect(contestedReason(0x0061)).toBeUndefined();
    expect(contestedReason(0x0131)).toContain('dotless');
    expect(contestedReason(0x13a5)).toContain('Cherokee');
  });
});

describe('the supplementary planes, where the two tables have different reach', () => {
  it('leaves a Deseret capital alone on NTFS, whose table is indexed by code unit', () => {
    const step = ntfsUpcase(0x10428);
    expect(step).toEqual({ ok: true, codePoint: 0x10428 });
  });

  it('folds the same character on a full range table', () => {
    expect(unicodeFold(0x10400)).toEqual({ ok: true, codePoint: 0x10428 });
  });

  it('makes a Deseret pair one file on APFS and two on NTFS', () => {
    const comparison = comparePair(`${DESERET_UPPER}.txt`, `${DESERET_LOWER}.txt`, [
      'ntfs',
      'apfs',
      'ext4',
    ]);
    expect(comparison.collidesOn).toEqual(['apfs']);
    expect(comparison.distinctOn).toEqual(['ntfs', 'ext4']);
  });

  it('leaves uncased supplementary characters alone on every target', () => {
    expect(() => collisionKey('\u{1F600}.png', 'ntfs')).not.toThrow();
    expect(collisionKey('\u{1F600}.png', 'apfs')).toBe(collisionKey('\u{1F600}.png', 'apfs'));
  });
});

describe('normalization', () => {
  const precomposed = 'café.pdf';
  const decomposed = `cafe${COMBINING_ACUTE}.pdf`;

  it('is one file where the volume folds normalization form', () => {
    expect(collisionKey(precomposed, 'apfs')).toBe(collisionKey(decomposed, 'apfs'));
    expect(collisionKey(precomposed, 'hfs-plus')).toBe(collisionKey(decomposed, 'hfs-plus'));
  });

  it('is two files where the volume stores what it is given', () => {
    expect(collisionKey(precomposed, 'ntfs')).not.toBe(collisionKey(decomposed, 'ntfs'));
    expect(collisionKey(precomposed, 'ext4')).not.toBe(collisionKey(decomposed, 'ext4'));
  });

  it('makes the same manifest a collision or not depending on the host', () => {
    const comparison = comparePair(precomposed, decomposed, ['apfs', 'ext4']);
    expect(comparison.collidesOn).toEqual(['apfs']);
    expect(comparison.distinctOn).toEqual(['ext4']);
    expect(comparison.reason).toContain('never normalizes');
  });

  it('folds combining marks written in either order, which canonical ordering settles', () => {
    const cedillaFirst = `e${COMBINING_CEDILLA}${COMBINING_ACUTE}.txt`;
    const acuteFirst = `e${COMBINING_ACUTE}${COMBINING_CEDILLA}.txt`;
    expect(cedillaFirst).not.toBe(acuteFirst);
    expect(collisionKey(cedillaFirst, 'apfs')).toBe(collisionKey(acuteFirst, 'apfs'));
    expect(collisionKey(cedillaFirst, 'ext4')).not.toBe(collisionKey(acuteFirst, 'ext4'));
  });
});

describe('the HFS+ decomposition, which is not NFD', () => {
  it('decomposes an ordinary accented letter', () => {
    expect(hfsPlusDecompose(A_RING)).toBe(`A${String.fromCodePoint(0x030a)}`);
  });

  it('leaves the excluded ranges alone', () => {
    expect(hfsPlusDecompose(ANGSTROM)).toBe(ANGSTROM);
    expect(ANGSTROM.normalize('NFD')).not.toBe(ANGSTROM);
  });

  it('makes two Apple filesystems disagree about the same pair of names', () => {
    const comparison = comparePair(`${ANGSTROM}.txt`, `${A_RING}.txt`, ['apfs', 'hfs-plus']);
    expect(comparison.collidesOn).toEqual(['apfs']);
    expect(comparison.distinctOn).toEqual(['hfs-plus']);
    expect(comparison.reason).toContain('decomposition it applies on write');
  });

  it('still folds case inside the excluded ranges', () => {
    expect(collisionKey(`${KELVIN}.txt`, 'hfs-plus')).toBe(collisionKey('k.txt', 'hfs-plus'));
  });
});

describe('the keys API', () => {
  it('returns one key per requested profile, in the order given', () => {
    const keys = collisionKeys('Report.pdf', ['ext4', 'ntfs']);
    expect(Array.from(keys.keys())).toEqual(['ext4', 'ntfs']);
    expect(keys.get('ntfs')).toBe('ntfs/REPORT.PDF');
    expect(keys.get('ext4')).toBe('ext4/Report.pdf');
  });

  it('refuses an unknown profile id instead of falling back to a default', () => {
    const error = refusal(() => collisionKey('a.txt', 'zfs' as never));
    expect(error.code).toBe('bad-config');
    expect(error.message).toContain('"ntfs"');
  });

  it('reports no disagreement for a pair that behaves the same everywhere', () => {
    const comparison = comparePair('a.txt', 'a.txt', ['ntfs', 'apfs', 'ext4']);
    expect(comparison.distinctOn).toEqual([]);
    expect(comparison.reason).toBe('');
  });

  it('reports no disagreement for two plainly different names', () => {
    const comparison = comparePair('a.txt', 'b.txt', ['ntfs', 'apfs', 'ext4']);
    expect(comparison.collidesOn).toEqual([]);
    expect(comparison.reason).toBe('');
  });
});
