/**
 * filename-collision-key: decide whether a proposed filename is already
 * taken on the filesystem it is actually going to land on, and refuse the
 * names where the answer depends on which machine you ask.
 *
 * The obvious implementation is a `Set` of raw strings, and the obvious
 * fix when someone reports a duplicate is a `Map` keyed on
 * `name.toLowerCase()`. Both are wrong, and they are wrong on names that
 * turn up in ordinary document uploads:
 *
 *   "report. " and "report"
 *       Win32 removes trailing dots and spaces from every path component
 *       before the call reaches the volume, so these are one file. A Set
 *       of raw strings compares two different strings, finds no
 *       collision, and the upload overwrites the existing report while
 *       the audit trail records a name that is not on disk.
 *
 *   "Kelvin.txt" and "kelvin.txt"
 *       The first begins with the Kelvin sign. Lowercasing turns it into
 *       "k" and merges the two, but NTFS compares through an uppercase
 *       table in which the Kelvin sign is already uppercase and stays
 *       itself, so NTFS holds two files. The lowercase Map has merged
 *       names the filesystem keeps apart.
 *
 *   "ı.txt" and "i.txt"
 *       The first is the dotless i, which uppercases to plain I, so an
 *       uppercase table merges them. Lowercasing leaves the dotless i
 *       alone and reports two files. The same lowercase Map has now split
 *       names the filesystem merges. One naive key is wrong in both
 *       directions against one filesystem.
 *
 *   "café.pdf" and "café.pdf"
 *       Decomposed and precomposed. One file on a normalization
 *       insensitive volume such as APFS, two files on ext4. There is no
 *       answer here that is true everywhere, so the same manifest is a
 *       collision or not depending on which host ran the check.
 *
 *   "CON.txt", "nul.log", "notes.txt:tag"
 *       None of these is a regular file on Windows. The first two are the
 *       console and null devices, and the third writes a hidden stream
 *       onto "notes.txt" while leaving its size unchanged in every
 *       listing. All three pass a validator that rejects slash,
 *       backslash and parent references.
 *
 * So the module does two things. It computes a per filesystem identity
 * key, using the case and normalization rules of the target rather than a
 * convenient approximation of them. And where those rules do not give one
 * answer, either because two targets disagree or because the target's own
 * table is not determined by the name, it refuses instead of guessing. A
 * wrong answer in this domain is a file replaced by a different file, with
 * both sides reporting success.
 */

export {
  FilenameIdentityError,
  formatCodePoint,
  joinList,
  quote,
  spell,
} from './errors.js';
export type { FilenameErrorCode, FilenameErrorContext } from './errors.js';

export { PROFILES, PROFILE_IDS, resolveProfile, resolveProfiles } from './profiles.js';
export type {
  CaseRule,
  FilesystemProfile,
  LengthUnit,
  NormalizationRule,
  ProfileId,
} from './profiles.js';

export {
  applyCaseRule,
  applyNormalization,
  assertNoContestedCharacters,
  contestedReason,
  hfsPlusDecompose,
  measure,
  ntfsUpcase,
  unicodeFold,
} from './unicode.js';
export type { FoldStep } from './unicode.js';

export {
  assertPortableName,
  assertProfileName,
  assertStoredLength,
  describeWin32Devices,
  isWin32Device,
  stripWin32Trailing,
  win32DeviceStem,
} from './name.js';

export { CollisionIndex, collisionKey, collisionKeys, comparePair } from './key.js';
export type {
  CollisionIndexOptions,
  IndexedName,
  PairComparison,
  ProfileRef,
  Verdict,
} from './key.js';
