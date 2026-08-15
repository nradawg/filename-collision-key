import { describe, expect, it } from 'vitest';
import { CollisionIndex, FilenameIdentityError, PROFILES } from '../src/index.js';

const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const KELVIN = String.fromCodePoint(0x212a);

function refusal(fn: () => unknown): FilenameIdentityError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FilenameIdentityError) return error;
    throw error;
  }
  throw new Error('expected a FilenameIdentityError, but the call returned normally');
}

describe('membership', () => {
  it('reports a fresh name as free and returns its keys', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'apfs', 'ext4'] });
    const verdict = index.check('report.pdf');
    expect(verdict.kind).toBe('free');
    expect(verdict.keys.get('ntfs')).toBe('ntfs/REPORT.PDF');
  });

  it('reports an exact duplicate as a collision on every profile', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'apfs', 'ext4'] });
    index.add('report.pdf');
    const verdict = index.check('report.pdf');
    expect(verdict.kind).toBe('collision');
    if (verdict.kind === 'collision') {
      expect(verdict.existing).toBe('report.pdf');
      expect(verdict.profiles).toEqual(['ntfs', 'apfs', 'ext4']);
    }
  });

  it('refuses a case variant when every listed target folds case', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'apfs'] });
    index.add('Report.pdf');

    const naive = new Set(['Report.pdf']);
    expect(naive.has('report.pdf')).toBe(false);

    const error = refusal(() => index.add('report.pdf'));
    expect(error.code).toBe('collision');
    expect(error.message).toContain('"Report.pdf"');
    expect(error.message).toContain('replace');
  });

  it('accepts a case variant when no listed target folds case', () => {
    const index = new CollisionIndex({ profiles: ['ext4'] });
    index.add('Report.pdf');
    index.add('report.pdf');
    expect(index.size).toBe(2);
  });

  it('tracks insertion order and reports it back', () => {
    const index = new CollisionIndex({ profiles: ['ext4'] });
    index.add('c.txt');
    index.add('a.txt');
    index.add('b.txt');
    expect(index.names()).toEqual(['c.txt', 'a.txt', 'b.txt']);
  });

  it('answers has() only for names that are taken on every target', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'apfs'] });
    index.add('Report.pdf');
    expect(index.has('REPORT.PDF')).toBe(true);
    expect(index.has('other.pdf')).toBe(false);
  });

  it('returns the keys it stored from add', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'ext4'] });
    const keys = index.add('Report.pdf');
    expect(keys.get('ntfs')).toBe('ntfs/REPORT.PDF');
    expect(keys.get('ext4')).toBe('ext4/Report.pdf');
  });

  it('finds the earliest matching entry when several would match', () => {
    const index = new CollisionIndex({ profiles: ['ext4'] });
    index.add('a.txt');
    index.add('b.txt');
    index.add('c.txt');
    const verdict = index.check('b.txt');
    expect(verdict.kind).toBe('collision');
    if (verdict.kind === 'collision') expect(verdict.existing).toBe('b.txt');
  });
});

describe('divergent identity', () => {
  it('refuses a case variant when the listed targets disagree about case', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'ext4'] });
    index.add('Report.pdf');
    const verdict = index.check('report.pdf');
    expect(verdict.kind).toBe('divergent');
    if (verdict.kind === 'divergent') {
      expect(verdict.collidesOn).toEqual(['ntfs']);
      expect(verdict.distinctOn).toEqual(['ext4']);
    }
  });

  it('throws divergent-identity from add and explains both sides', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'ext4'] });
    index.add('Report.pdf');
    const error = refusal(() => index.add('report.pdf'));
    expect(error.code).toBe('divergent-identity');
    expect(error.other).toBe('Report.pdf');
    expect(error.message).toContain('ntfs');
    expect(error.message).toContain('ext4');
    expect(error.message).toContain('only true locally');
  });

  it('refuses a decomposed spelling of an indexed precomposed name', () => {
    const index = new CollisionIndex({ profiles: ['apfs', 'ext4'] });
    index.add('café.pdf');
    const error = refusal(() => index.add(`cafe${COMBINING_ACUTE}.pdf`));
    expect(error.code).toBe('divergent-identity');
  });

  it('accepts the same pair when the manifest targets only the Apple volume', () => {
    const mac = new CollisionIndex({ profiles: ['apfs'] });
    mac.add('café.pdf');
    const error = refusal(() => mac.add(`cafe${COMBINING_ACUTE}.pdf`));
    expect(error.code).toBe('collision');
  });

  it('accepts the same pair when the manifest targets only Linux', () => {
    const linux = new CollisionIndex({ profiles: ['ext4'] });
    linux.add('café.pdf');
    linux.add(`cafe${COMBINING_ACUTE}.pdf`);
    expect(linux.size).toBe(2);
  });

  it('refuses the Kelvin sign pair, which no single naive key gets right', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'apfs'] });
    index.add('kelvin.txt');
    const verdict = index.check(`${KELVIN}elvin.txt`);
    expect(verdict.kind).toBe('divergent');
    if (verdict.kind === 'divergent') {
      expect(verdict.collidesOn).toEqual(['apfs']);
      expect(verdict.distinctOn).toEqual(['ntfs']);
    }
  });

  it('leaves the index unchanged after a refusal', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'ext4'] });
    index.add('Report.pdf');
    expect(() => index.add('report.pdf')).toThrow(FilenameIdentityError);
    expect(index.size).toBe(1);
    expect(index.names()).toEqual(['Report.pdf']);
  });

  it('propagates a name level refusal out of check as well as add', () => {
    const index = new CollisionIndex({ profiles: ['ntfs'] });
    expect(refusal(() => index.check('CON.txt')).code).toBe('reserved-device');
    expect(refusal(() => index.add('report. ')).code).toBe('trailing-strip');
  });
});

describe('configuration', () => {
  it('refuses an empty profile list rather than defaulting to everything', () => {
    const error = refusal(() => new CollisionIndex({ profiles: [] }));
    expect(error.code).toBe('bad-config');
    expect(error.message).toContain('report every name as available');
  });

  it('refuses a duplicated profile', () => {
    const error = refusal(() => new CollisionIndex({ profiles: ['ntfs', 'ntfs'] }));
    expect(error.code).toBe('bad-config');
  });

  it('refuses an unknown profile id', () => {
    const error = refusal(() => new CollisionIndex({ profiles: ['btrfs' as never] }));
    expect(error.code).toBe('bad-config');
  });

  it('refuses a missing options object', () => {
    const error = refusal(() => new CollisionIndex(undefined as never));
    expect(error.code).toBe('bad-config');
    expect(error.message).toContain('profiles');
  });

  it('accepts a caller supplied profile record', () => {
    const index = new CollisionIndex({
      profiles: [{ ...PROFILES.ext4, id: 'ext4', maxNameLength: 8 }],
    });
    index.add('short.md');
    expect(refusal(() => index.add('muchlonger.md')).code).toBe('name-too-long');
  });

  it('builds an index from an iterable and refuses on the offending name', () => {
    const index = CollisionIndex.from(['a.txt', 'b.txt'], { profiles: ['ntfs'] });
    expect(index.size).toBe(2);
    expect(
      refusal(() => CollisionIndex.from(['a.txt', 'A.TXT'], { profiles: ['ntfs'] })).code,
    ).toBe('collision');
  });
});

describe('a realistic upload batch', () => {
  it('lets a clean batch through and stops the one name that is not what it looks like', () => {
    const index = new CollisionIndex({ profiles: ['ntfs', 'apfs', 'ext4'] });
    const accepted: string[] = [];
    const rejected: { name: string; code: string }[] = [];

    for (const name of [
      'Q3 summary.pdf',
      'notes.md',
      'Q3 summary.pdf ',
      'archive.tar.gz',
      'CON.txt',
      'notes.md',
    ]) {
      try {
        index.add(name);
        accepted.push(name);
      } catch (error) {
        if (!(error instanceof FilenameIdentityError)) throw error;
        rejected.push({ name, code: error.code });
      }
    }

    expect(accepted).toEqual(['Q3 summary.pdf', 'notes.md', 'archive.tar.gz']);
    expect(rejected).toEqual([
      { name: 'Q3 summary.pdf ', code: 'trailing-strip' },
      { name: 'CON.txt', code: 'reserved-device' },
      { name: 'notes.md', code: 'collision' },
    ]);
  });
});
