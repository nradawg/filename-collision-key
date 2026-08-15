/**
 * Keys, and the index that compares them.
 *
 * A collision key is a string with one property: two names produce the
 * same key on a profile exactly when that filesystem stores them as one
 * file. Everything else here follows from wanting that property to hold
 * rather than approximately hold.
 *
 * The key carries its profile id as a prefix. Keys from different profiles
 * are never comparable, and a bare folded string invites exactly that
 * mistake: someone keys uploads by the APFS rule, keys the existing
 * inventory by the NTFS rule, compares the two, and gets an answer that
 * corresponds to no filesystem at all. Making the prefix part of the value
 * turns that into a miss rather than a wrong hit.
 *
 * The interesting part is not the key, it is what happens when two
 * profiles disagree. A name pair that is one file on APFS and two on ext4
 * has no portable answer, and returning either one is a lie on half the
 * fleet. `CollisionIndex` reports that case as its own verdict and
 * `add` refuses it.
 */

import { FilenameIdentityError, joinList, quote, spell } from './errors.js';
import { assertProfileName, assertPortableName, assertStoredLength } from './name.js';
import type { FilesystemProfile, ProfileId } from './profiles.js';
import { resolveProfile, resolveProfiles } from './profiles.js';
import { applyCaseRule, applyNormalization } from './unicode.js';

export type ProfileRef = ProfileId | FilesystemProfile;

/**
 * Computes the identity key for one name on one filesystem.
 *
 * Throws for any name whose stored identity is not the string that was
 * passed. Notably it does not repair such names: applying the Win32
 * trailing strip here would produce a correct key for a name the caller
 * still has recorded in its original spelling, and the two drifting apart
 * is the whole failure this module exists to prevent.
 */
export function collisionKey(name: string, profileRef: ProfileRef): string {
  const profile = resolveProfile(profileRef);
  assertPortableName(name);
  assertProfileName(name, profile);

  const stored = applyNormalization(name, profile.normalizationRule);
  assertStoredLength(stored, name, profile);
  const folded = applyCaseRule(stored, profile, name);

  return `${profile.id}/${folded}`;
}

/** Computes the key on each of several profiles, in the order given. */
export function collisionKeys(
  name: string,
  profileRefs: readonly ProfileRef[],
): ReadonlyMap<ProfileId, string> {
  const profiles = resolveProfiles(profileRefs);
  const keys = new Map<ProfileId, string>();
  for (const profile of profiles) keys.set(profile.id, collisionKey(name, profile));
  return keys;
}

function mergeAccount(profile: FilesystemProfile, a: string, b: string): string {
  const normalizedA = applyNormalization(a, profile.normalizationRule);
  const normalizedB = applyNormalization(b, profile.normalizationRule);
  if (normalizedA === normalizedB) {
    return `${profile.label} folds both spellings to one stored form (${spell(normalizedA)}) before it compares anything, so it holds a single file`;
  }
  return `${profile.label} maps both spellings through its case table onto the same entry, so it holds a single file`;
}

/**
 * Why a profile keeps the pair apart.
 *
 * Case can never be the answer when the stored forms already match: the
 * same fold applied to two identical strings cannot separate them. So the
 * split is either a normalization difference that survived, or a case
 * table that did not reach far enough, and the branches below say which.
 */
function splitAccount(profile: FilesystemProfile, a: string, b: string): string {
  const storedA = applyNormalization(a, profile.normalizationRule);
  const storedB = applyNormalization(b, profile.normalizationRule);
  const canonicallyEquivalent = a.normalize('NFD') === b.normalize('NFD');

  if (storedA !== storedB && canonicallyEquivalent) {
    return profile.normalizationRule === 'preserve-exact'
      ? `${profile.label} stores the code points it is handed and never normalizes, so two canonically equivalent spellings stay apart and it holds two`
      : `${profile.label} leaves these code points out of the decomposition it applies on write, so two canonically equivalent spellings still reach the disk in different forms and it holds two`;
  }
  if (profile.caseRule === 'sensitive') {
    return `${profile.label} does not fold case, so it holds two`;
  }
  return `${profile.label} folds case through its own table, which maps these two spellings to separate entries, so it holds two`;
}

export interface PairComparison {
  readonly a: string;
  readonly b: string;
  /** Profiles on which the two names are the same file. */
  readonly collidesOn: readonly ProfileId[];
  /** Profiles on which the two names are two files. */
  readonly distinctOn: readonly ProfileId[];
  /** Prose account of why the profiles disagree, empty when they do not. */
  readonly reason: string;
}

/**
 * Compares two names across a profile set without building an index.
 *
 * Useful on its own for explaining a refusal, and it is what the index
 * uses internally, so the explanation a caller prints is derived from the
 * same computation that produced the verdict rather than from a second
 * implementation that can drift.
 */
export function comparePair(
  a: string,
  b: string,
  profileRefs: readonly ProfileRef[],
): PairComparison {
  const profiles = resolveProfiles(profileRefs);
  const collidesOn: ProfileId[] = [];
  const distinctOn: ProfileId[] = [];
  for (const profile of profiles) {
    if (collisionKey(a, profile) === collisionKey(b, profile)) collidesOn.push(profile.id);
    else distinctOn.push(profile.id);
  }

  let reason = '';
  if (collidesOn.length > 0 && distinctOn.length > 0) {
    const merging = profiles.find((profile) => profile.id === collidesOn[0]);
    const splitting = profiles.find((profile) => profile.id === distinctOn[0]);
    if (merging !== undefined && splitting !== undefined) {
      reason = `${mergeAccount(merging, a, b)}, while ${splitAccount(splitting, a, b)}`;
    }
  }

  return { a, b, collidesOn, distinctOn, reason };
}

export interface IndexedName {
  readonly name: string;
  readonly keys: ReadonlyMap<ProfileId, string>;
}

export type Verdict =
  | {
      readonly kind: 'free';
      readonly name: string;
      readonly keys: ReadonlyMap<ProfileId, string>;
    }
  | {
      readonly kind: 'collision';
      readonly name: string;
      readonly keys: ReadonlyMap<ProfileId, string>;
      /** The indexed name this one is identical to. */
      readonly existing: string;
      /** Every requested profile, since a collision verdict means all of them agree. */
      readonly profiles: readonly ProfileId[];
    }
  | {
      readonly kind: 'divergent';
      readonly name: string;
      readonly keys: ReadonlyMap<ProfileId, string>;
      readonly existing: string;
      readonly collidesOn: readonly ProfileId[];
      readonly distinctOn: readonly ProfileId[];
      readonly reason: string;
    };

export interface CollisionIndexOptions {
  /** The filesystems these names have to be unambiguous on. Required, and not defaulted. */
  readonly profiles: readonly ProfileRef[];
}

interface Entry extends IndexedName {
  readonly order: number;
}

/**
 * A set of filenames that knows which filesystems it has to be valid on.
 *
 * Not a `Set<string>` with a normalizer bolted on. The membership question
 * has three answers here, not two, and the third one (the profiles
 * disagree) is the one a Set cannot represent and the one that actually
 * destroys data.
 */
export class CollisionIndex {
  readonly profiles: readonly FilesystemProfile[];

  /** Per profile buckets from key to the names holding it, for lookup without a scan. */
  readonly #buckets: Map<ProfileId, Map<string, string[]>>;
  readonly #entries: Map<string, Entry>;
  #order = 0;

  constructor(options: CollisionIndexOptions) {
    if (options === null || typeof options !== 'object' || !Array.isArray(options.profiles)) {
      throw new FilenameIdentityError(
        'bad-config',
        'CollisionIndex requires an options object with a `profiles` array, for example new CollisionIndex({ profiles: ["ntfs", "apfs", "ext4"] }). There is no default set, because a default would silently decide which filesystems your files have to agree on and that decision changes which names the index reports as available.',
      );
    }
    this.profiles = resolveProfiles(options.profiles);
    this.#buckets = new Map();
    this.#entries = new Map();
    for (const profile of this.profiles) this.#buckets.set(profile.id, new Map());
  }

  /** Builds an index and adds every name, refusing on the first problem. */
  static from(names: Iterable<string>, options: CollisionIndexOptions): CollisionIndex {
    const index = new CollisionIndex(options);
    for (const name of names) index.add(name);
    return index;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The indexed names, in insertion order. */
  names(): readonly string[] {
    return Array.from(this.#entries.values())
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.name);
  }

  /** The key this name would take on each profile. Throws for names the index refuses outright. */
  keysFor(name: string): ReadonlyMap<ProfileId, string> {
    const keys = new Map<ProfileId, string>();
    for (const profile of this.profiles) keys.set(profile.id, collisionKey(name, profile));
    return keys;
  }

  /**
   * Reports what would happen if this name were added.
   *
   * A divergent verdict outranks a plain collision. A plain collision is
   * a local problem with a local fix: pick another name. A divergence
   * means the manifest itself is not portable, which is the answer a
   * caller has to see first.
   *
   * An index filled through `add` cannot actually produce both verdicts
   * for one proposed name, since a name that collides everywhere with one
   * entry has that entry's keys exactly, and would therefore diverge from
   * anything the proposed name diverges from. The ordering is here so the
   * verdict stays right for an index assembled some other way rather than
   * resting on that argument.
   */
  check(name: string): Verdict {
    const keys = this.keysFor(name);

    const candidates = new Map<string, Entry>();
    for (const profile of this.profiles) {
      const bucket = this.#buckets.get(profile.id);
      const key = keys.get(profile.id);
      if (bucket === undefined || key === undefined) continue;
      for (const other of bucket.get(key) ?? []) {
        const entry = this.#entries.get(other);
        if (entry !== undefined) candidates.set(other, entry);
      }
    }
    if (candidates.size === 0) return { kind: 'free', name, keys };

    const ordered = Array.from(candidates.values()).sort((left, right) => left.order - right.order);

    let collision: Verdict | undefined;
    for (const entry of ordered) {
      const collidesOn: ProfileId[] = [];
      const distinctOn: ProfileId[] = [];
      for (const profile of this.profiles) {
        if (keys.get(profile.id) === entry.keys.get(profile.id)) collidesOn.push(profile.id);
        else distinctOn.push(profile.id);
      }
      if (collidesOn.length === 0) continue;
      if (distinctOn.length === 0) {
        collision ??= {
          kind: 'collision',
          name,
          keys,
          existing: entry.name,
          profiles: collidesOn,
        };
        continue;
      }
      const comparison = comparePair(name, entry.name, this.profiles);
      return {
        kind: 'divergent',
        name,
        keys,
        existing: entry.name,
        collidesOn,
        distinctOn,
        reason: comparison.reason,
      };
    }

    return collision ?? { kind: 'free', name, keys };
  }

  /** True when the name is already the same file as something in the index on every profile. */
  has(name: string): boolean {
    return this.check(name).kind === 'collision';
  }

  /**
   * Adds the name, or refuses. Refusal is the useful direction: an index
   * that accepted a divergent name would be a record of a decision that is
   * only true on the machine that made it.
   */
  add(name: string): ReadonlyMap<ProfileId, string> {
    const verdict = this.check(name);

    if (verdict.kind === 'collision') {
      throw new FilenameIdentityError(
        'collision',
        `The proposed name ${quote(name)} is the same file as the indexed name ${quote(verdict.existing)} on every target you listed (${joinList(verdict.profiles)}). Storing it would not add a second file, it would replace the first one, and because the two strings differ your own records would show two documents where the volume holds one, with no error anywhere to notice. Rename the incoming file, or route it as an update to ${quote(verdict.existing)} if that is what it actually is.`,
        { subject: name, other: verdict.existing },
      );
    }

    if (verdict.kind === 'divergent') {
      throw new FilenameIdentityError(
        'divergent-identity',
        `The proposed name ${quote(name)} is the same file as the indexed name ${quote(verdict.existing)} on ${joinList(verdict.collidesOn)} and a different file on ${joinList(verdict.distinctOn)}. ${verdict.reason.length > 0 ? `${verdict.reason[0]?.toUpperCase() ?? ''}${verdict.reason.slice(1)}. ` : ''}The answer to "do these collide" therefore depends on which host runs the check, so a manifest built on one target is wrong on the other: one importer writes two files and the other writes one, and neither reports an error. This module will not return a verdict that is only true locally. Rename one of the two so they differ on every target, or narrow the profile list to the single filesystem these files will really live on.`,
        { subject: name, other: verdict.existing },
      );
    }

    for (const profile of this.profiles) {
      const bucket = this.#buckets.get(profile.id);
      const key = verdict.keys.get(profile.id);
      if (bucket === undefined || key === undefined) continue;
      const holders = bucket.get(key);
      if (holders === undefined) bucket.set(key, [name]);
      else holders.push(name);
    }
    this.#entries.set(name, { name, keys: verdict.keys, order: this.#order });
    this.#order += 1;
    return verdict.keys;
  }
}
