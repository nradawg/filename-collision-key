/**
 * Refusals.
 *
 * Every rejection carries a machine-readable code and a message that says
 * what the name does, why the filesystem disagrees with the caller about
 * it, and what to pass instead. The messages are long on purpose: the
 * whole failure mode this module exists to prevent is somebody looking at
 * a name, seeing nothing wrong, and shipping it.
 */

import type { ProfileId } from './profiles.js';

export type FilenameErrorCode =
  /** The requested set of profiles is empty, duplicated, or names a profile that does not exist. */
  | 'bad-config'
  /** The name is empty, or is not a string at all. */
  | 'empty-name'
  /** The name is "." or "..", which every filesystem reserves for directory traversal. */
  | 'dot-segment'
  /** The name contains a character that some target treats as a path separator. */
  | 'path-separator'
  /** The name contains U+0000, which cannot survive any filesystem call. */
  | 'nul-byte'
  /** The name contains a C0 control character that a Windows target rejects. */
  | 'control-character'
  /** The name contains a character Windows reserves for its own syntax. */
  | 'forbidden-character'
  /** The name contains a colon, which Windows reads as an alternate data stream suffix. */
  | 'alternate-data-stream'
  /** The name ends in dots or spaces that Windows removes before the call reaches the volume. */
  | 'trailing-strip'
  /** The name resolves to a DOS device rather than to a file on disk. */
  | 'reserved-device'
  /** The name contains a character whose case behavior is not the same across plausible tables. */
  | 'contested-fold'
  /** The stored form of the name exceeds a profile's per-component limit. */
  | 'name-too-long'
  /** The name is the same file as an existing name on every requested profile. */
  | 'collision'
  /** The name is the same file as an existing name on some profiles and a different file on others. */
  | 'divergent-identity';

export interface FilenameErrorContext {
  /** The profile whose rules produced the refusal, when the refusal is profile specific. */
  readonly profile?: ProfileId;
  /** The name that was refused. */
  readonly subject?: string;
  /** The already indexed name involved in a collision or a divergence. */
  readonly other?: string;
  /** The offending code point, for character level refusals. */
  readonly codePoint?: number;
}

export class FilenameIdentityError extends Error {
  readonly code: FilenameErrorCode;
  readonly profile: ProfileId | undefined;
  readonly subject: string | undefined;
  readonly other: string | undefined;
  readonly codePoint: number | undefined;

  constructor(code: FilenameErrorCode, message: string, context: FilenameErrorContext = {}) {
    super(message);
    this.name = 'FilenameIdentityError';
    this.code = code;
    this.profile = context.profile;
    this.subject = context.subject;
    this.other = context.other;
    this.codePoint = context.codePoint;
  }
}

/** Formats one code point as U+XXXX for use in a message. */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Spells a string out as code points.
 *
 * Messages about this module's subject matter are useless when rendered
 * naively: a trailing space, a combining acute accent and a precomposed
 * one all print as either nothing or as the same glyph, which is exactly
 * why the caller did not notice the problem in the first place. Anywhere a
 * message needs to distinguish two strings that look identical, it spells
 * them instead of quoting them.
 */
export function spell(value: string): string {
  const points: string[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    points.push(formatCodePoint(codePoint));
  }
  return points.length === 0 ? '(empty)' : points.join(' ');
}

/**
 * Quotes a name for a message, escaping anything that would not survive
 * the trip through a terminal. Callers that need to distinguish
 * lookalikes use `spell` as well, not instead: the quoted form is what the
 * reader recognises, and the spelled form is what settles the argument.
 */
export function quote(value: string): string {
  let out = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (character === '"') out += '\\"';
    else if (character === '\\') out += '\\\\';
    else if (codePoint < 0x20 || codePoint === 0x7f) out += `\\u{${codePoint.toString(16).toUpperCase()}}`;
    else out += character;
  }
  return `${out}"`;
}

/** Joins a list into readable prose, since these messages are sentences. */
export function joinList(items: readonly string[]): string {
  if (items.length === 0) return 'none';
  if (items.length === 1) return items[0] ?? 'none';
  const head = items.slice(0, -1).join(', ');
  const tail = items[items.length - 1] ?? '';
  return `${head} and ${tail}`;
}
