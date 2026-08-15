# filename-collision-key

Decide whether a proposed filename is already taken on the filesystem it is actually going to land on, and refuse the names where the answer depends on which machine you ask.

```ts
import { CollisionIndex, collisionKey } from 'filename-collision-key';

const index = new CollisionIndex({ profiles: ['ntfs', 'apfs', 'ext4'] });
index.add('Q3 summary.pdf');

index.check('notes.md');            // { kind: 'free', ... }
index.check('Q3 SUMMARY.pdf');      // { kind: 'divergent', collidesOn: ['ntfs', 'apfs'], distinctOn: ['ext4'] }
index.add('Q3 summary.pdf ');       // throws: Win32 strips the trailing space, so this is the same file

collisionKey('Report.pdf', 'ntfs'); // 'ntfs/REPORT.PDF'
collisionKey('Report.pdf', 'ext4'); // 'ext4/Report.pdf'
```

There is no default profile list. Two names are the same file only relative to a set of target filesystems, and an index built without one would report every name as available.

## The naive version is a Set, and it silently overwrites documents

```ts
const taken = new Set(existingNames);
if (!taken.has(proposed)) upload(proposed);
```

`"report. "` and `"report"` are different strings, so the Set reports no collision. They are one file. The Win32 path parser removes trailing dots and spaces from every path component before the call reaches the volume, so the upload opens `report`, replaces the document that was there, and writes an audit record naming a file that does not exist on disk. Nothing errors on either side.

The same parser explains three more names that pass every regex built around slash, backslash and `..`:

- `CON.txt` and `nul.log` resolve to the console and null devices. Win32 compares the portion before the first dot against a device table and ignores the extension, so the write succeeds, reports the full byte count, and produces no file.
- `notes.txt:tag` writes an alternate data stream onto `notes.txt`. The listing shows `notes.txt` at its original size and the stream is invisible to anything not asking for it by name.
- `... ` strips down to nothing at all, so the write targets the containing directory.

This module refuses all of them rather than repairing them. Repair produces a name the caller never asked for while the caller's own database still holds the original string, which is how the two drift apart in the first place. Every refusal names the file that would really have been touched:

```
The proposed name "report. " ends with 2 characters that Win32 removes from every
path component before the call reaches the volume: U+002E U+0020. This is not a
validation preference, it happens inside the path parser, so the write lands on
"report" instead, silently replacing that file if it already exists while your
records keep the longer spelling, so the audit trail shows an upload of a name that
is not on disk and no trace of the overwrite. A set of raw strings reports no
collision here because the two spellings really are different strings, and the
filesystem still treats them as one file. Pass "report" if that is the file you mean.
```

## Lowercasing is wrong in both directions against a single filesystem

The usual fix, once someone reports a duplicate, is `new Map(names.map(n => [n.toLowerCase(), n]))`. Lowercase is neither the NTFS upcase table nor the APFS fold, and the gap is not exotic characters nobody types.

**It merges names NTFS keeps apart.** `Kelvin.txt` beginning with the Kelvin sign (U+212A) lowercases to `kelvin.txt`, so the Map treats them as one entry and drops one of the two files. NTFS compares through `$UpCase`, an **uppercase** table, and the Kelvin sign is already uppercase, so it stays itself and NTFS holds two separate files.

**It splits names NTFS merges.** `ı.txt` with the dotless i (U+0131) lowercases to itself, so the Map reports two entries. The dotless i uppercases to plain `I`, so `$UpCase` folds it onto `i` and NTFS holds one file. Upload both and the second overwrites the first.

One key, one filesystem, both failure modes at once. That happens because uppercase and lowercase are not inverses over Unicode, and a key built from one of them cannot describe a filesystem that compares with the other.

Two structural facts shape the tables in `src/unicode.ts`:

`$UpCase` is a 65536 entry table indexed by UTF-16 code unit. It has no entry for anything above the BMP and surrogate code units have no case, so cased supplementary characters are **never** folded on NTFS. `ntfsUpcase` returns them unchanged, which is why a Deseret capital and its lowercase are one file on APFS and two on NTFS.

A table with one entry per code unit cannot hold a mapping that grows. Sharp s uppercases to `SS` and the ffi ligature to `FFI`, so no fixed width table carries those mappings and different generations resolve them differently. Rather than pick, both fold functions return `{ ok: false, reason }` and the name is refused.

That refusal also covers a policy list of characters whose behavior is genuinely disputed between plausible target tables: the Turkish dotted and dotless I, sharp s in both spellings, final sigma, the micro sign, the long s, Cherokee (cased only since Unicode 8.0) and Georgian Mtavruli (Unicode 11.0). A volume formatted by an older system carries an older table and gives a different answer, and a collision key that picked one would be quietly wrong on half a fleet. A profile that compares bytes has nothing to dispute and accepts all of them, so `collisionKey('ı.txt', 'ext4')` succeeds while the NTFS and APFS calls do not.

The contested scan runs on the name as written, before normalization. NFD hides the problem: `İ` decomposes into an ordinary `I` and a combining dot, neither of which is contested alone, so a scan of the normalized form waves through the exact character the list exists to catch.

## Case and normalization are separate axes, and profiles differ on each

A single `caseInsensitive` boolean cannot describe any of these volumes:

| profile | case | normalization | Win32 name rules |
| --- | --- | --- | --- |
| `ntfs` | `$UpCase` table | none, stores UTF-16 verbatim | yes |
| `apfs` | Unicode fold | insensitive | no |
| `apfs-case-sensitive` | none | insensitive | no |
| `hfs-plus` | Unicode fold | decomposes on write, with exclusions | no |
| `ext4` | none | none | no |

The pair people assume moves together is the one that does not. An APFS case sensitive volume still folds normalization, so `café.pdf` written decomposed and written precomposed are one file there while a name differing only in case is two.

That gives the module its second job. On a case insensitive, normalization insensitive volume the decomposed and precomposed spellings are one file; on ext4 they are two. There is no answer that is true on both, so `check` returns a third verdict beside free and collision:

```ts
const index = new CollisionIndex({ profiles: ['apfs', 'ext4'] });
index.add('café.pdf');                  // precomposed
index.add('café.pdf');            // decomposed: throws divergent-identity
```

> The proposed name `"café.pdf"` is the same file as the indexed name `"café.pdf"` on apfs and a different file on ext4. APFS case insensitive folds both spellings to one stored form (U+0063 U+0061 U+0066 U+0065 U+0301 U+002E U+0070 U+0064 U+0066) before it compares anything, so it holds a single file, while ext4 stores the code points it is handed and never normalizes, so two canonically equivalent spellings stay apart and it holds two. The answer to "do these collide" therefore depends on which host runs the check, so a manifest built on one target is wrong on the other: one importer writes two files and the other writes one, and neither reports an error.

Narrow the profile list to the one filesystem these files will really live on and the same pair is an ordinary collision. That is the point: the verdict is a fact about a target, and the module will not produce one that is only true on the machine that asked.

HFS+ is in the table because it disagrees with APFS on the same Mac. HFS+ does not store NFD, it stores a decomposition that skips several ranges, including U+2000 through U+2FFF. The Angstrom sign U+212B lives in that gap, so `Å.txt` written with U+212B and written with U+00C5 are one file on APFS and two on HFS+.

## What the key is

`collisionKey` returns `profileId + '/' + folded`. The profile id is part of the value because keys from two profiles are never comparable, and a bare folded string invites exactly that mistake: key the uploads by one rule, key the existing inventory by another, compare them, and get an answer corresponding to no filesystem at all. With the prefix that becomes a miss instead of a wrong hit. The separator is safe because a forward slash in a name is refused before any key is computed.

Length is measured on the **stored** form, in the unit the target limits. NTFS and HFS+ limit UTF-16 code units; APFS and ext4 limit UTF-8 bytes. A name that decomposes on write grows, so 100 precomposed accented letters are 200 bytes on ext4 and 300 once APFS splits every accent into its own combining mark, which is over the limit. Measuring the input would pass a name the target cannot create.

`CollisionIndex` buckets by key per profile, so a check is a lookup rather than a scan, then compares the full key set for each candidate to classify the verdict. Divergence outranks collision: a collision is a local problem with a local fix, and a divergence means the manifest is not portable, which is the answer a caller has to see first.

## Known limitations

**The tables are models, not the volume's own tables.** `$UpCase` is written into an NTFS volume when it is formatted, so its contents depend on the Windows version that formatted it, and this module cannot read it. The contested list is where that uncertainty is handled explicitly, and it is a hand maintained policy list rather than a derivation from Unicode data files. Characters outside it are folded with `toUpperCase` and `toLowerCase` restricted to single code point results, which matches the simple mappings the real tables are generated from but is not a byte for byte reproduction of any specific one.

**`unicodeFold` is a simple lowercase, not Unicode case folding.** They differ on a small set of characters, and the ones this module knows about are on the contested list and refused. Others may exist. If you need certainty for a specific script, test it against your actual target before trusting a `free` verdict.

**The Win32 rules model the Win32 layer, not NTFS.** A program that opens files through the NT namespace, or through a `\\?\` prefixed path, sees no trailing strip, no device names and no stream syntax. The profile models Win32 because that is what applications hit, but a service using extended length paths will find this profile stricter than its runtime.

**ext4 is modelled without the casefold feature.** A directory with `+F` set folds case against an encoding chosen at filesystem creation time, and this profile does not represent that. Supply your own `FilesystemProfile` record if you run one.

**Only one path component at a time.** These are filenames, not paths. A slash is a refusal, not a delimiter. Split paths and check each component.

**Nothing here touches the disk.** The verdicts describe what a filesystem would do with these names, not what is currently on it. A directory that already contains a divergent pair, created before this check existed, is not discovered by adding names to an index.

**No repair suggestions beyond the obvious.** The refusals tell you which file would really have been written and leave the rename to you, because generating a replacement name means generating one that might itself already be taken.

## Test

```bash
npm install
npm test   # 97 tests: trailing strip, device names, streams, case tables, normalization, divergence
```

## License

MIT
