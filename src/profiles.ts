/**
 * Filesystem identity profiles.
 *
 * A profile is not a description of a product. It is the answer to one
 * question: given two byte sequences offered as filenames, does this
 * volume consider them the same file? Three independent axes decide that,
 * and every real filesystem picks a different combination:
 *
 *   CASE       does the volume fold case, and with which table
 *   NORMALIZE  does the volume fold Unicode normalization forms
 *   SYNTAX     which names are not regular files at all on this platform
 *
 * The axes are independent, which is the part that trips people up. APFS
 * case sensitive volumes still fold normalization. NTFS folds case but
 * stores UTF-16 verbatim and never normalizes. ext4 does neither. A single
 * boolean called `caseInsensitive` cannot express any of this, and a
 * manifest checked with one is right on the machine that ran the check and
 * wrong on the machine that receives the files.
 */

import { FilenameIdentityError, joinList } from './errors.js';

export type ProfileId = 'ntfs' | 'apfs' | 'apfs-case-sensitive' | 'hfs-plus' | 'ext4';

export type CaseRule =
  /** Two names differing only in case are two files. */
  | 'sensitive'
  /** Folded through the NTFS $UpCase table, a 65536 entry UTF-16 code unit table. */
  | 'ntfs-upcase'
  /** Folded through a Unicode derived lowercase table covering the full code point range. */
  | 'unicode-fold';

export type NormalizationRule =
  /** Bytes are stored and compared exactly as given. */
  | 'preserve-exact'
  /** Any normalization form of the same text is the same file. */
  | 'insensitive-nfd'
  /** Decomposed on write, but with the HFS+ ranges that are left alone. */
  | 'hfs-plus-nfd';

export type LengthUnit = 'utf16-code-units' | 'utf8-bytes';

export interface FilesystemProfile {
  readonly id: ProfileId;
  /** Human readable name, used in error messages so they read as sentences. */
  readonly label: string;
  readonly caseRule: CaseRule;
  readonly normalizationRule: NormalizationRule;
  /**
   * Whether the Win32 layer sits between the caller and the volume. This
   * is deliberately not called `isWindows`: the trailing strip, the DOS
   * device names and the stream syntax are all Win32 path parsing, not
   * NTFS, and a program that opens the volume through the NT namespace
   * sees none of them. Applications hit Win32, so Win32 is what a profile
   * for a Windows target has to model.
   */
  readonly win32NameRules: boolean;
  readonly maxNameLength: number;
  readonly lengthUnit: LengthUnit;
}

export const PROFILES: { readonly [K in ProfileId]: FilesystemProfile } = {
  ntfs: {
    id: 'ntfs',
    label: 'NTFS reached through Win32',
    // NTFS compares through $UpCase, a table written into the volume when
    // it is formatted. It folds case and it does nothing else: NTFS stores
    // the UTF-16 it was handed and never normalizes, so a precomposed and
    // a decomposed spelling of the same word are two separate files.
    caseRule: 'ntfs-upcase',
    normalizationRule: 'preserve-exact',
    win32NameRules: true,
    maxNameLength: 255,
    lengthUnit: 'utf16-code-units',
  },
  apfs: {
    id: 'apfs',
    label: 'APFS case insensitive',
    caseRule: 'unicode-fold',
    normalizationRule: 'insensitive-nfd',
    win32NameRules: false,
    maxNameLength: 255,
    lengthUnit: 'utf8-bytes',
  },
  'apfs-case-sensitive': {
    id: 'apfs-case-sensitive',
    label: 'APFS case sensitive',
    // The case sensitive variant is still normalization insensitive. This
    // is the axis pair people assume moves together and does not: a
    // decomposed name and a precomposed one collide here even though a
    // name differing only in case does not.
    caseRule: 'sensitive',
    normalizationRule: 'insensitive-nfd',
    win32NameRules: false,
    maxNameLength: 255,
    lengthUnit: 'utf8-bytes',
  },
  'hfs-plus': {
    id: 'hfs-plus',
    label: 'HFS+ case insensitive',
    caseRule: 'unicode-fold',
    // HFS+ decomposes on write rather than comparing normalization
    // insensitively, and its decomposition skips several ranges. That is
    // not equivalent to NFD, and the difference is observable against
    // APFS on the same machine.
    normalizationRule: 'hfs-plus-nfd',
    win32NameRules: false,
    maxNameLength: 255,
    lengthUnit: 'utf16-code-units',
  },
  ext4: {
    id: 'ext4',
    label: 'ext4',
    // ext4 without the casefold feature enabled compares bytes. The only
    // characters it rejects are the path separator and NUL, which means it
    // accepts a great many names that no other target here will store.
    caseRule: 'sensitive',
    normalizationRule: 'preserve-exact',
    win32NameRules: false,
    maxNameLength: 255,
    lengthUnit: 'utf8-bytes',
  },
};

export const PROFILE_IDS: readonly ProfileId[] = [
  'ntfs',
  'apfs',
  'apfs-case-sensitive',
  'hfs-plus',
  'ext4',
];

function isProfileId(value: string): value is ProfileId {
  return Object.prototype.hasOwnProperty.call(PROFILES, value);
}

/** Accepts either a built in profile id or a profile record supplied by the caller. */
export function resolveProfile(reference: ProfileId | FilesystemProfile): FilesystemProfile {
  if (typeof reference === 'string') {
    if (!isProfileId(reference)) {
      throw new FilenameIdentityError(
        'bad-config',
        `There is no filesystem profile called ${JSON.stringify(reference)}. A collision key only means something relative to a specific set of identity rules, so this module will not fall back to a default profile and guess which volume you meant. Pass one of ${joinList(PROFILE_IDS.map((id) => JSON.stringify(id)))}, or pass a FilesystemProfile record of your own if you are targeting something else.`,
      );
    }
    return PROFILES[reference];
  }
  return reference;
}

/**
 * Resolves the profile set a key or an index is computed against.
 *
 * An empty set is refused rather than treated as "all profiles". A caller
 * who forgot to configure the targets would otherwise get an index that
 * reports every name as free, which is the most dangerous possible
 * behavior for a module whose entire job is to say no.
 */
export function resolveProfiles(
  references: readonly (ProfileId | FilesystemProfile)[],
): readonly FilesystemProfile[] {
  if (references.length === 0) {
    throw new FilenameIdentityError(
      'bad-config',
      'The profile list is empty. Two names are the same file only relative to a set of target filesystems, so an empty list has no answer to give and an index built on one would report every name as available. List the filesystems the files will actually land on, for example ["ntfs", "apfs", "ext4"] for a sync product that has to agree across all three.',
    );
  }
  const resolved = references.map(resolveProfile);
  const seen = new Set<ProfileId>();
  for (const profile of resolved) {
    if (seen.has(profile.id)) {
      throw new FilenameIdentityError(
        'bad-config',
        `The profile ${JSON.stringify(profile.id)} appears more than once in the profile list. Duplicates change nothing about which names collide but they do change the reported profile lists on every verdict, which makes "collides everywhere" and "collides on some targets" harder to tell apart in a log. Remove the duplicate.`,
        { profile: profile.id },
      );
    }
    seen.add(profile.id);
  }
  return resolved;
}
