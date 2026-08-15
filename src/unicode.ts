/**
 * The case and normalization tables.
 *
 * The reason this file exists rather than a call to `toLowerCase()` is
 * that lowercasing is not what any of these filesystems do, and the ways
 * it differs are not rare characters nobody types.
 *
 * NTFS compares through $UpCase, an uppercase table. Uppercase and
 * lowercase are not inverses over Unicode. The dotless i (U+0131)
 * uppercases to plain I, so on NTFS it is the same file as "i", while
 * lowercasing leaves it alone and reports two files. The Kelvin sign
 * (U+212A) is already uppercase, so NTFS leaves it alone and keeps it
 * distinct from "K", while lowercasing turns it into "k" and merges it
 * with a name NTFS considers separate. One naive table is therefore wrong
 * in both directions at once against a single filesystem.
 *
 * Two further constraints shape everything below.
 *
 * $UpCase is a 65536 entry table indexed by UTF-16 code unit. It has no
 * entry for anything outside the BMP, and surrogate code units have no
 * case, so cased characters in the supplementary planes are never folded
 * on NTFS no matter what Unicode says about them. A table that handles
 * the full code point range disagrees, and both are correct about their
 * own volume.
 *
 * A one entry per code unit table also cannot express a mapping that
 * grows. Sharp s uppercases to two letters and the ffi ligature to three,
 * so no fixed width table can carry those mappings and different table
 * generations resolve them differently. Rather than pick one, this module
 * refuses names containing characters whose folding is not settled. That
 * is the point of the module: a wrong answer here is an overwrite, and an
 * overwrite is worse than a rejection.
 */

import { FilenameIdentityError, formatCodePoint } from './errors.js';
import type { FilesystemProfile, NormalizationRule } from './profiles.js';

interface ContestedRange {
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

/**
 * Characters whose case behavior is genuinely disputed between the tables
 * a real target might be carrying.
 *
 * This is a policy list, not a derivation. Every entry is here because two
 * defensible implementations give different answers about whether some
 * pair of names is one file, and a collision key that picked a side would
 * be quietly wrong on half the fleet. Names containing these characters
 * are refused by any profile that folds case at all. A profile that
 * compares bytes has nothing to dispute and accepts them.
 */
const CONTESTED: readonly ContestedRange[] = [
  {
    from: 0x0130,
    to: 0x0130,
    reason:
      'the capital I with dot above has no single code point lowercase form (Unicode lowercases it to "i" followed by the combining dot U+0307), so a fixed width fold table either leaves it alone and keeps it distinct from "i", or folds it down and merges the two, and which one the target volume does is not decidable from the name',
  },
  {
    from: 0x0131,
    to: 0x0131,
    reason:
      'the dotless i uppercases to plain "I" under the simple mapping that an uppercase style table is built from, which makes it the same file as "i" on that volume, while a table built from the Unicode case folding data leaves it alone and keeps the two names apart',
  },
  {
    from: 0x00df,
    to: 0x00df,
    reason:
      'sharp s uppercases to the two letters "SS", which no fixed width per code unit table can store, so implementations variously leave it unchanged, map it to the capital sharp s U+1E9E, or fold it together with a literal "ss" spelling, and the three choices disagree about which names are the same file',
  },
  {
    from: 0x1e9e,
    to: 0x1e9e,
    reason:
      'capital sharp s was added in Unicode 5.1 and pairs with U+00DF, whose uppercase mapping no fixed width table can store, so whether these two are one file depends on which Unicode version the target volume table was generated from',
  },
  {
    from: 0x03c2,
    to: 0x03c2,
    reason:
      'final sigma folds together with ordinary sigma under Unicode case folding but is left alone by a simple lowercase mapping, so two Greek names that differ only in which sigma ends a word are one file on some targets and two on others',
  },
  {
    from: 0x00b5,
    to: 0x00b5,
    reason:
      'the micro sign folds to Greek small mu U+03BC under Unicode case folding but is unchanged by a simple lowercase mapping, so a name written with the micro sign and the same name written with mu are one file on some targets and two on others',
  },
  {
    from: 0x017f,
    to: 0x017f,
    reason:
      'the long s folds to plain "s" under Unicode case folding and uppercases to plain "S" under the simple mapping, but a table built only from lowercase data leaves it alone, so whether it is the same file as an "s" spelling depends on which data the target table was generated from',
  },
  {
    from: 0x13a0,
    to: 0x13f5,
    reason:
      'Cherokee only acquired case mappings in Unicode 8.0, so a volume formatted by an older system carries a table that treats these letters as caseless and keeps upper and lower Cherokee names apart, while a newer table merges them',
  },
  {
    from: 0xab70,
    to: 0xabbf,
    reason:
      'the Cherokee small letters were added in Unicode 8.0 as the lowercase of the earlier Cherokee block, so a volume whose table predates that release keeps them distinct from their uppercase counterparts and a newer one does not',
  },
  {
    from: 0x1c90,
    to: 0x1cbf,
    reason:
      'Georgian Mtavruli was added in Unicode 11.0 as the uppercase of the Mkhedruli letters, so a volume formatted before that release treats Georgian as caseless and keeps the two spellings apart while a newer table merges them',
  },
];

/** Returns why this code point is refused by folding profiles, or undefined. */
export function contestedReason(codePoint: number): string | undefined {
  for (const range of CONTESTED) {
    if (codePoint >= range.from && codePoint <= range.to) return range.reason;
  }
  return undefined;
}

export type FoldStep =
  | { readonly ok: true; readonly codePoint: number }
  | { readonly ok: false; readonly reason: string };

/**
 * The NTFS side: fold by uppercasing, one code point in and one out.
 *
 * Supplementary plane characters come back untouched. That is not an
 * omission, it is what a UTF-16 code unit indexed table does, and it is
 * the reason a Deseret name pair that a full range table merges stays
 * distinct on NTFS.
 */
export function ntfsUpcase(codePoint: number): FoldStep {
  const contested = contestedReason(codePoint);
  if (contested !== undefined) return { ok: false, reason: contested };

  if (codePoint > 0xffff) return { ok: true, codePoint };

  const upper = String.fromCodePoint(codePoint).toUpperCase();
  const points = Array.from(upper);
  const first = points[0];
  if (points.length !== 1 || first === undefined) {
    return {
      ok: false,
      reason: `${formatCodePoint(codePoint)} uppercases to ${points.length} code points, and a table with one entry per code unit cannot store a mapping that grows, so different table generations resolve it differently and disagree about which names are the same file`,
    };
  }
  const mapped = first.codePointAt(0);
  if (mapped === undefined) return { ok: true, codePoint };
  return { ok: true, codePoint: mapped };
}

/**
 * The APFS and HFS+ side: fold by lowercasing, one code point in and one
 * out, across the full code point range including the supplementary
 * planes.
 */
export function unicodeFold(codePoint: number): FoldStep {
  const contested = contestedReason(codePoint);
  if (contested !== undefined) return { ok: false, reason: contested };

  const lower = String.fromCodePoint(codePoint).toLowerCase();
  const points = Array.from(lower);
  const first = points[0];
  if (points.length !== 1 || first === undefined) {
    return {
      ok: false,
      reason: `${formatCodePoint(codePoint)} lowercases to ${points.length} code points, and a fold table with one entry per input cannot store a mapping that grows, so whether the target volume folds it at all is not decidable from the name`,
    };
  }
  const mapped = first.codePointAt(0);
  if (mapped === undefined) return { ok: true, codePoint };
  return { ok: true, codePoint: mapped };
}

/**
 * Ranges HFS+ leaves alone when it decomposes a name on write.
 *
 * HFS+ does not store NFD. It stores a decomposition that skips these
 * ranges, which were excluded to keep round tripping with legacy encodings
 * and with the Unicode compatibility blocks intact. The practical effect
 * is that the Angstrom sign U+212B, which NFD turns into "A" plus a
 * combining ring, survives on HFS+ as itself. So the Angstrom spelling and
 * the A ring spelling are the same file on APFS and two different files on
 * HFS+, on the same machine, for the same user.
 */
const HFS_UNDECOMPOSED: readonly (readonly [number, number])[] = [
  [0x2000, 0x2fff],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];

function isHfsUndecomposed(codePoint: number): boolean {
  for (const range of HFS_UNDECOMPOSED) {
    if (codePoint >= range[0] && codePoint <= range[1]) return true;
  }
  return false;
}

/**
 * Applies the HFS+ decomposition.
 *
 * Runs of ordinary text are normalized as runs rather than one code point
 * at a time, so canonical ordering of combining marks is preserved within
 * a run. An excluded code point passes through verbatim and also ends the
 * run, because a mark sequence spanning it was never going to be reordered
 * across it on the real volume either.
 */
export function hfsPlusDecompose(name: string): string {
  let out = '';
  let run = '';
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isHfsUndecomposed(codePoint)) {
      out += run.normalize('NFD');
      run = '';
      out += character;
      continue;
    }
    run += character;
  }
  return out + run.normalize('NFD');
}

export function applyNormalization(name: string, rule: NormalizationRule): string {
  switch (rule) {
    case 'preserve-exact':
      return name;
    case 'insensitive-nfd':
      // NFD rather than NFC because a normalization insensitive volume
      // hashes the decomposed form, and because NFD is the form that
      // separates a base letter from its marks so canonical reordering
      // can put differently ordered mark sequences into one shape.
      return name.normalize('NFD');
    case 'hfs-plus-nfd':
      return hfsPlusDecompose(name);
  }
}

/**
 * Applies the profile's case rule across a whole name.
 *
 * `original` is passed separately from `name` so the refusal can quote the
 * string the caller supplied rather than the intermediate normalized form,
 * which the caller has never seen and did not write.
 */
export function applyCaseRule(
  name: string,
  profile: FilesystemProfile,
  original: string,
): string {
  if (profile.caseRule === 'sensitive') return name;
  const fold = profile.caseRule === 'ntfs-upcase' ? ntfsUpcase : unicodeFold;

  let out = '';
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const step = fold(codePoint);
    if (!step.ok) {
      throw new FilenameIdentityError(
        'contested-fold',
        `The name ${JSON.stringify(original)} contains ${formatCodePoint(codePoint)}, whose case behavior on ${profile.label} is not settled: ${step.reason}. Because a wrong answer here means an upload silently replaces a different file rather than failing, this module refuses the name instead of picking a side. Rewrite the name without ${formatCodePoint(codePoint)}, or route these files to a profile that compares bytes, such as ext4, where nothing is folded and the question does not arise.`,
        { profile: profile.id, subject: original, codePoint },
      );
    }
    out += String.fromCodePoint(step.codePoint);
  }
  return out;
}

/**
 * Scans the name as the caller wrote it for contested characters.
 *
 * This runs before normalization on purpose. NFD hides the problem: the
 * capital I with dot above decomposes into an ordinary "I" and a combining
 * dot, neither of which is contested on its own, so a scan of the
 * normalized form would wave through the exact character the list exists
 * to catch.
 */
export function assertNoContestedCharacters(name: string, profile: FilesystemProfile): void {
  if (profile.caseRule === 'sensitive') return;
  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const reason = contestedReason(codePoint);
    if (reason === undefined) continue;
    throw new FilenameIdentityError(
      'contested-fold',
      `The name ${JSON.stringify(name)} contains ${formatCodePoint(codePoint)}, whose case behavior on ${profile.label} is not settled: ${reason}. This module refuses the name rather than choosing one of the possible answers, because choosing wrong means a later upload overwrites a file that only looked like a different name. Rewrite the name without ${formatCodePoint(codePoint)}, or store these files on a profile that compares bytes, such as ext4.`,
      { profile: profile.id, subject: name, codePoint },
    );
  }
}

/** Counts the name in the unit the profile actually limits. */
export function measure(name: string, unit: 'utf16-code-units' | 'utf8-bytes'): number {
  if (unit === 'utf16-code-units') return name.length;
  return new TextEncoder().encode(name).length;
}
