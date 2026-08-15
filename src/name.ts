/**
 * Syntax rules: the names that are not the file the caller thinks they are.
 *
 * Collision keys only mean something for names that denote a regular file
 * whose stored spelling is the spelling that was offered. Several very
 * ordinary looking strings fail that test, and the usual validator, a
 * regex that rejects slash, backslash and "..", passes every one of them.
 *
 *   "report. "       Win32 removes trailing dots and spaces before the
 *                    call reaches the volume, so this creates and opens
 *                    the file "report". A Set of raw strings sees two
 *                    names and no collision. The upload overwrites the
 *                    existing report and the audit log records a name
 *                    that is not on disk.
 *
 *   "CON.txt"        Resolves to the console device. The write succeeds,
 *                    returns a byte count, and produces no file.
 *
 *   "notes.txt:tag"  Writes an alternate data stream on "notes.txt".
 *                    Directory listings show "notes.txt" at its original
 *                    size and the stream is invisible.
 *
 * Each of these is refused rather than repaired. Repairing means the
 * module hands back a name the caller never asked for, and the caller's
 * database still holds the original string, which is how the two drift
 * apart in the first place.
 */

import { FilenameIdentityError, formatCodePoint, joinList, quote, spell } from './errors.js';
import type { FilesystemProfile } from './profiles.js';
import { assertNoContestedCharacters, measure } from './unicode.js';

/**
 * Characters Win32 reserves for its own path syntax. The colon is absent
 * because it gets its own refusal: it is not merely illegal, it silently
 * redirects the write to a stream on another file.
 */
const WIN32_FORBIDDEN = new Set(['<', '>', '"', '|', '?', '*']);

/**
 * The DOS device names, still resolved by Win32 path parsing in every
 * directory, on every drive, forty years after the hardware they named.
 *
 * The superscript variants are not a joke. Win32 device parsing accepts
 * the superscript digits U+00B9, U+00B2 and U+00B3 where it expects the
 * port number, so "COM¹" is the first serial port. CONIN$ and CONOUT$
 * were added later and behave the same way.
 */
const WIN32_DEVICES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³'].flatMap(
    (digit) => [`COM${digit}`, `LPT${digit}`],
  ),
]);

/**
 * Removes the trailing dots and spaces Win32 removes.
 *
 * Only U+0020 counts. A no break space at the end of a name survives the
 * trip and stays part of the filename, which is why this cannot be
 * `trimEnd()`: that would strip a character the filesystem keeps and
 * report a collision that does not exist.
 */
export function stripWin32Trailing(name: string): string {
  let end = name.length;
  while (end > 0) {
    const character = name[end - 1];
    if (character !== '.' && character !== ' ') break;
    end -= 1;
  }
  return name.slice(0, end);
}

/**
 * The portion Win32 compares against the device table: everything before
 * the first dot, with trailing spaces ignored. The extension is not part
 * of the comparison, which is why "CON.txt" and "nul.log" are devices and
 * not files.
 */
export function win32DeviceStem(name: string): string {
  const stripped = stripWin32Trailing(name);
  const dot = stripped.indexOf('.');
  const stem = dot === -1 ? stripped : stripped.slice(0, dot);
  let end = stem.length;
  while (end > 0 && stem[end - 1] === ' ') end -= 1;
  return stem.slice(0, end);
}

/** True when Win32 would route this name to a device rather than to disk. */
export function isWin32Device(name: string): boolean {
  return WIN32_DEVICES.has(win32DeviceStem(name).toUpperCase());
}

/**
 * Checks that hold on every target, including the byte comparing ones.
 * These are refusals about the name being a filename at all rather than
 * about identity, so they run before any profile is consulted.
 */
export function assertPortableName(name: unknown): asserts name is string {
  if (typeof name !== 'string') {
    throw new FilenameIdentityError(
      'empty-name',
      `A filename must be a string, and this one is ${name === null ? 'null' : typeof name}. Passing a non string means something upstream produced a value that was never a name, and coercing it here would turn that bug into a file on disk called "undefined" or "[object Object]". Fix the caller.`,
    );
  }
  if (name.length === 0) {
    throw new FilenameIdentityError(
      'empty-name',
      'The proposed name is the empty string. No filesystem here can store it, and an empty component in a path resolves to the containing directory rather than to a file, so a write under this name would target the directory itself. Supply a name, or reject the upload upstream where the empty value came from.',
      { subject: name },
    );
  }
  if (name === '.' || name === '..') {
    throw new FilenameIdentityError(
      'dot-segment',
      `The proposed name is ${JSON.stringify(name)}, which every filesystem here reserves for directory traversal rather than for a file. A write under this name resolves to ${name === '.' ? 'the containing directory' : 'the parent directory'} and can escape the location you meant to write into. Reject it at the boundary where the name was received.`,
      { subject: name },
    );
  }
  if (name.includes('/')) {
    throw new FilenameIdentityError(
      'path-separator',
      `The proposed name ${quote(name)} contains a forward slash, which is a path separator on every target here. This is one name component, not a path, so a slash inside it means the caller is trying to create a nested path through a single name argument. Split the path into components and check each one, or reject the input.`,
      { subject: name },
    );
  }
  if (name.includes('\u0000')) {
    throw new FilenameIdentityError(
      'nul-byte',
      `The proposed name ${quote(name)} contains U+0000. Filesystem calls take NUL terminated strings, so the name that actually reaches the volume is truncated at that point and is a different, shorter name than the one recorded here. That truncated name can collide with a file the caller never looked at. Reject the input.`,
      { subject: name, codePoint: 0 },
    );
  }
}

function assertWin32Syntax(name: string, profile: FilesystemProfile): void {
  if (name.includes('\\')) {
    throw new FilenameIdentityError(
      'path-separator',
      `The proposed name ${quote(name)} contains a backslash. On ${profile.label} a backslash is a path separator, so this is not one name at all but a path through a directory that may not exist, while on a byte comparing target such as ext4 the backslash is an ordinary character in a perfectly legal filename. The same string is therefore a different thing on each side of a sync, which is exactly the ambiguity this module refuses to resolve on your behalf. Remove the backslash or split the value into components.`,
      { profile: profile.id, subject: name },
    );
  }

  for (const character of name) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new FilenameIdentityError(
        'control-character',
        `The proposed name ${quote(name)} contains the control character ${formatCodePoint(codePoint)}, which ${profile.label} rejects outright. A byte comparing target such as ext4 stores it happily, so a name that exists on the Linux side of a transfer simply cannot be created on the Windows side, and a pipeline that strips the character to recover ends up with a name that may already be taken. Remove the control character before the name enters the system.`,
        { profile: profile.id, subject: name, codePoint },
      );
    }
    if (WIN32_FORBIDDEN.has(character)) {
      throw new FilenameIdentityError(
        'forbidden-character',
        `The proposed name ${quote(name)} contains ${JSON.stringify(character)} (${formatCodePoint(codePoint)}), which ${profile.label} reserves for wildcards and redirection and will not store in a filename. ext4 accepts it, so this name can exist on one side of a sync and be uncreatable on the other. Remove the character rather than substituting for it, because the substitute may collide with a name that already exists.`,
        { profile: profile.id, subject: name, codePoint },
      );
    }
  }

  if (name.includes(':')) {
    const colon = name.indexOf(':');
    const base = name.slice(0, colon);
    throw new FilenameIdentityError(
      'alternate-data-stream',
      `The proposed name ${quote(name)} contains a colon, which ${profile.label} reads as the start of an alternate data stream suffix rather than as part of the filename. A write under this name does not create a file: it attaches a hidden stream to ${base.length === 0 ? 'the containing directory' : quote(base)}, which keeps its original size in every directory listing while the stream contents are invisible to anything that is not asking for them by name. Nothing errors, and the file the caller believes they created does not exist. Remove the colon.`,
      { profile: profile.id, subject: name },
    );
  }

  const stripped = stripWin32Trailing(name);
  if (stripped !== name) {
    const removed = name.slice(stripped.length);
    const consequence =
      stripped.length === 0
        ? 'the name reduces to nothing at all, so the write targets the containing directory rather than a file'
        : `the write lands on ${quote(stripped)} instead, silently replacing that file if it already exists while your records keep the longer spelling, so the audit trail shows an upload of a name that is not on disk and no trace of the overwrite`;
    const deviceNote = isWin32Device(stripped)
      ? ` What is left is also the reserved device name ${quote(win32DeviceStem(stripped).toUpperCase())}, so the write would not produce a file even if the trailing characters were the only problem.`
      : '';
    throw new FilenameIdentityError(
      'trailing-strip',
      `The proposed name ${quote(name)} ends with ${removed.length} character${removed.length === 1 ? '' : 's'} that Win32 removes from every path component before the call reaches the volume: ${spell(removed)}. This is not a validation preference, it happens inside the path parser, so ${consequence}.${deviceNote} A set of raw strings reports no collision here because the two spellings really are different strings, and the filesystem still treats them as one file. Pass ${stripped.length === 0 ? 'an actual name' : quote(stripped)} if that is the file you mean.`,
      { profile: profile.id, subject: name },
    );
  }

  if (isWin32Device(name)) {
    const stem = win32DeviceStem(name).toUpperCase();
    throw new FilenameIdentityError(
      'reserved-device',
      `The proposed name ${quote(name)} resolves to the DOS device ${quote(stem)} on ${profile.label}, because Win32 compares the portion before the first dot against the device table and ignores the extension entirely. A write succeeds, reports the full byte count, and produces no file: the bytes go to ${stem === 'NUL' ? 'the null device and are discarded' : 'the device rather than to disk'}. A later read finds nothing, and on a byte comparing target the same name is an ordinary file, so the two sides of a sync disagree about whether the content exists. Rename it, for example by prefixing the stem, since appending an extension does not help.`,
      { profile: profile.id, subject: name },
    );
  }
}

/**
 * Every check a profile imposes on the name as written, before
 * normalization and folding turn it into a key.
 */
export function assertProfileName(name: string, profile: FilesystemProfile): void {
  if (profile.win32NameRules) assertWin32Syntax(name, profile);
  assertNoContestedCharacters(name, profile);
}

/**
 * Checks the length of the form the volume actually stores.
 *
 * The stored form is not the form the caller passed. A name that
 * decomposes on write grows: an accented Latin name at 250 bytes in its
 * precomposed spelling is over the limit once the volume splits every
 * accent into its own combining mark. Measuring the input would pass a
 * name the target cannot create.
 */
export function assertStoredLength(
  stored: string,
  original: string,
  profile: FilesystemProfile,
): void {
  const size = measure(stored, profile.lengthUnit);
  if (size <= profile.maxNameLength) return;
  const unit = profile.lengthUnit === 'utf8-bytes' ? 'UTF-8 bytes' : 'UTF-16 code units';
  const grew =
    stored === original
      ? ''
      : ` The name as you wrote it measures ${measure(original, profile.lengthUnit)} ${unit}; it grows on write because ${profile.label} stores a decomposed form, which gives every accent its own code point.`;
  throw new FilenameIdentityError(
    'name-too-long',
    `The proposed name is ${size} ${unit} in the form ${profile.label} stores, and the limit for one path component there is ${profile.maxNameLength}.${grew} Targets here measure in different units, so a name can fit on one and not another: 200 emoji are 200 code points, 400 UTF-16 code units and 800 UTF-8 bytes. Shorten the name to fit the smallest target you sync with rather than letting one side truncate, because two names truncated to the same prefix become one file.`,
    { profile: profile.id, subject: original },
  );
}

/** Exposed for callers that want to explain a refusal in their own words. */
export function describeWin32Devices(): string {
  return joinList(Array.from(WIN32_DEVICES).sort());
}
