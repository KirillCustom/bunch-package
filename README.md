# bunch-package

> Patch management tool for Bun - alternative to patch-package

`bunch-package` lets you fix broken node_modules instantly and persist the changes through `postinstall` scripts. It's like `patch-package` but optimized for Bun.

## Why bunch-package?

- **Built for bun's install cache.** Bun links installed packages to a shared cache,
  so editing a file in `node_modules` edits the cache too. Every command here knows
  that; a tool written for npm does not.
- **Five commands:** create, apply, status, rebase and retarget.
- **It tells you when it cannot do something.** Binary files, symbolic links, a hunk
  that no longer fits — all of them are named out loud rather than dropped, because
  a patch that silently carries less than you think is worse than no patch.
- **Applying twice changes nothing**, even for a patch that once landed a few lines
  away from where it said it would.

## Installation

```bash
bun add -d bunch-package
```

## Usage

### 1. Fix a bug in node_modules

Make changes directly in `node_modules/some-package`

### 2. Create a patch

```bash
bunx bunch-package create some-package
```

This creates `patches/some-package+1.2.3.patch`

### 3. Add postinstall script

In your `package.json`:

```json
{
  "scripts": {
    "postinstall": "bunx bunch-package apply"
  }
}
```

### 4. Commit the patch

```bash
git add patches/
git commit -m "fix: patch some-package"
```

Now whenever someone runs `bun install`, patches are automatically applied!

## Commands

| Command | What it does |
|---|---|
| `create <package>` | Create or update a patch for a package |
| `apply` | Apply every patch in `patches/` |
| `status` | Show which patches are in the tree right now |
| `rebase <package> <patch>` | Un-apply the patches sitting on top of one, to edit it |
| `retarget <package>` | Move its patches to the version now installed |

### Create a patch

```bash
bunx bunch-package create <package-name>
```

Example:
```bash
bunx bunch-package create react-native-date-picker
```

`create` downloads a pristine copy of the package to compare against, and gives
that download 60 seconds. On a slow link, or for a very large package, that is not
always enough — raise it with `BUNCH_FETCH_TIMEOUT`, in seconds:

```bash
BUNCH_FETCH_TIMEOUT=300 bunx bunch-package create some-enormous-package
```

The pristine copy is kept in a cache of its own — `~/.cache/bunch-package/pristine`
(`%LOCALAPPDATA%\bunch-package\pristine` on Windows), moved elsewhere with
`BUNCH_PRISTINE_CACHE`. It is separate from bun's own cache on purpose: bun links
packages out of that cache, so a file edited in place in `node_modules` would
change the cached copy too, and the "pristine" package would arrive already
patched. Deleting the cache is always safe; the next `create` refills it.

Keeping it costs disk and saves the download. Measured on `typescript@5.4.5`
(31 MB): `create` takes 3.8 s the first time and 0.6 s after that, against 8–10 s
every single run when the copy was fetched from scratch.

If the resulting diff would be larger than 50 MB, `create` refuses instead of
writing a truncated patch. That size nearly always means generated or build output
is being compared rather than source.

### Multiple patches for one package

```bash
bunx bunch-package create <package-name> --append <name>
```

Adds another patch instead of overwriting the existing one:

```
patches/react-native+0.81.4+001+initial.patch
patches/react-native+0.81.4+002+fix-touchable.patch
```

The patches form a sequence and build on each other, like commits. Each one is
diffed against the state left by the ones before it, so a later patch contains only
its own change. `create` without `--append` updates the **last** patch in the
sequence, leaving the earlier ones alone. The naming matches `patch-package`, so
patches travel between the two.

A sequence is recognised as applied by its last patch, since that is the state the
tree ends up in — an intermediate patch cannot be checked on its own once a later
one sits on top of it.

### Apply all patches

```bash
bunx bunch-package apply
```

Applies all patches from the `patches/` directory.

A patch counts as applied only when its changes are actually in the tree. The whole
patch is computed in memory first, and nothing is written unless every file in it
fits — so a patch can never leave your tree half-changed, and a failed apply leaves
no `.rej` or `.orig` files behind. Applying the same patch twice is a no-op.

Each file is written beside its target and moved over it, so a file is never visible
half-written or briefly missing. An `apply` killed outright — Ctrl-C, a CI runner
that died, a disk that filled up — leaves every file either as it was or fully
patched, and running `apply` again finishes the job. Writing in place instead would
leave a truncated file that no later `apply` could ever patch, because a hunk does
not fit against emptiness.

Only one `apply` runs at a time. It holds `node_modules/.bunch-package.lock` for the
length of the run; a second `apply` waits up to 30 seconds for the first to finish,
then reports who is holding the lock. Two runs a moment apart are ordinary —
`postinstall` firing twice, workspaces installing in parallel — and without the lock
they can interleave into a tree that is neither the patched nor the unpatched one. A
lock left behind by a killed run is recognised by the process id inside it and taken
over, so a killed `apply` does not lock the project up.

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Every patch is in the tree (applied now or already applied) |
| `1` | At least one patch failed — the reason is printed under it, and nothing was written |

A non-zero exit makes `postinstall` fail, so a broken patch stops CI instead of
silently shipping an unpatched build.

Patches created by bunch-package before 1.1.0 contain absolute paths and cannot be
applied; `apply` reports them as failed and asks you to recreate them with `create`.

### Editing a patch that is not the last one

`create` without `--append` updates the last patch of a sequence. To change an
earlier one, first take off the patches sitting on top of it:

```bash
bunx bunch-package rebase react-native 001+initial
```

```
🔧 Rebasing react-native onto react-native+0.81.4+001+initial.patch...
  ↩️  react-native+0.81.4+002+fix-touchable.patch

Now edit node_modules/react-native, then run:
  bunch-package create react-native                   to update react-native+0.81.4+001+initial.patch
  bunch-package create react-native --append <name>   to insert a patch after it
  bunch-package apply                                 to put the rest back
```

The target can be named however is convenient — `001+initial`, `initial`, `1`, or
the file name — and `0` un-applies the whole sequence, which is how you insert a
new patch before all the others. This is what `--rebase` does in `patch-package`,
so the habit travels along with the patches.

Un-applying is applying the patch backwards, through the same code that applies it
forwards: one implementation, one set of rules for creations, deletions, renames,
modes and missing trailing newlines. A patch the tree no longer matches is refused
rather than half-removed, exactly like a patch that does not apply.

Un-applying has a limit worth knowing, measured on 289 real patches from public
repositories: 285 of them restore the package byte for byte, and four come back
differing only in trailing whitespace — a `\r` here and there. The reason is
inherent: the patch is the only record of the lines it removed, and patches
routinely store those lines with trailing whitespace stripped or added. `rebase`
re-applies the patch to what it is about to write and refuses when that does not
reproduce the current tree, which catches the mismatches it can see; a difference
only in trailing whitespace passes that check, because re-applying the patch hides
it again.

After the rebase, `create` updates the patch you rebased onto rather than the last
one in the sequence. It knows which that is from the record `apply` and `rebase`
keep — checked against the tree, since a record can go stale: the patches above the
target must really be absent, or their changes would be swallowed into the patch
being rewritten.

### After upgrading the package

A patch is written against one exact version. Upgrade the package and the patch
file still says the old one — `apply` warns about the mismatch and then it is up to
you. `retarget` moves the patches over:

```bash
bunx bunch-package retarget ms
```

```
📦 Moving 1 patch(es) for ms from 2.1.2 to 2.1.3...
📥 Fetching pristine ms@2.1.3...
  ✅ ms+2.1.2.patch → ms+2.1.3.patch

📊 1 patch(es) now target 2.1.3
   Run `bunch-package apply` to put them into node_modules.
```

Each patch is replayed onto a pristine copy of the installed version and diffed
back out, so the new file carries context lines and line numbers from that version
— the patch stops being approximately right and becomes exact. A sequence moves as
a whole, keeping its numbers and labels, and each patch keeps carrying only its own
change.

Three things it will tell you rather than paper over:

- **A patch that no longer fits.** The package changed around it. Nothing is
  written, the old patch files stay where they are, and the message names the file
  and hunk, so you can make the change by hand and run `create`.
- **A patch that is no longer needed**, because the fix went upstream between the
  versions. It is dropped, and said aloud.
- **Patches for more than one version in `patches/`**, which means the sequence is
  not in a state anyone can move safely.

How often this works is measured, not promised. Of 289 patches taken from public
repositories, applied to the next published version of their package: 64% still fit
and were moved, 5% had already been fixed upstream, and 30% no longer fit. Jumping
straight to the latest version instead — often many releases later — only 22% fit.
A patch is written against one version, and the further the package moves, the less
of it survives.

### What is in the tree right now

```bash
bunx bunch-package status
```

```
📋 2 patch(es) in patches/

  ✅ is-number+7.0.0.patch — in the tree, applied 2026-08-21T17:46:38.613Z
  ⬜ left-pad+1.3.0.patch — not in the tree, applied 2026-08-20T09:12:04.201Z

📊 1 of 2 in the tree
```

Every answer is worked out from `node_modules` itself, by checking whether each
patch is already in the files. `apply` also keeps a record at
`node_modules/.bunch-package-state.json` — which patch, which version, the hash of
the patch file, and when it first landed — and `status` uses it only for the parts
the tree cannot tell you: when a patch was applied, whether the patch file has been
edited since, and whether a patch file that used to be applied has been deleted
while its changes are still in `node_modules`. The record is never taken as proof
that a patch is applied; the files are.

`status` exits `1` when anything is missing from the tree, so it can stand in CI as
a cheap check that `node_modules` is what the patches say it should be.

## What gets excluded?

`bunch-package` automatically excludes, at any depth:

- Binary files (`*.so`, `*.jar`, `*.aar`, `*.class`, `*.dex`, `*.apk`, `*.a`, `*.framework`, `*.xcframework`, `*.dylib`)
- Media files (`*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`)
- Fonts (`*.ttf`, `*.otf`, `*.woff`, `*.woff2`)
- Leftovers from a failed apply (`*.rej`, `*.orig`)
- `patch-package`'s own state file (`.patch-package.json`), which it writes inside
  the patched package — so a project moving over from it does not carry that file
  into its first patch
- Version control (`.git/`, `node_modules/`)

Build artifacts are excluded by path, not by name:

- `.gradle/`, `.cxx/`, `.transforms/`, `DerivedData/` and `Pods/` at any depth — these are never source
- `build/` **only** under a platform directory (`android/build/`, `ios/build/`, …)

A `build/` directory at the root of a package is *not* excluded: for a great many
packages that is where their published JavaScript lives, and dropping it would
silently discard the change you came to make. Anything skipped is listed in the
output — `create` never drops a path without saying so.

Binary files cannot be represented in a text diff. `create` lists the ones that
differ rather than letting the change disappear, and it refuses outright if a
changed file is not valid UTF-8, because writing that patch would corrupt it.

Symbolic links cannot travel in a patch either — the format carries file contents,
not links. `create` lists every link that differs instead of reporting no changes.
`apply` refuses a patch section that describes a symlink (git writes those with
mode `120000`), and refuses to overwrite a symlink that is already in
`node_modules`: putting a regular file where a link belongs would report success
and leave you with the wrong tree.

## What it understands

Unified diffs as `git diff` and `patch-package` write them: content hunks, file
creation and deletion, renames, mode changes, and files with no trailing newline.
Patch files in CRLF are read correctly against LF sources.

Context lines are compared ignoring trailing whitespace, because trailing
whitespace does not survive editors, linters or the GitHub web editor — and a line
that is only indentation becomes an empty one. Context is verified but never
rewritten: only added and removed lines reach your files.

Hunks are located at the line the patch declares, then by widening search, matching
`patch`'s offset handling. Fuzzy context matching is deliberately absent — a patch
is made against one exact version, and stretching context to fit is how a failure
comes to look like a success.

Whether a patch is already in the tree is decided by reading the file both ways:
how well the hunks' old side fits, and how well the new side fits, each located by
the same widening search. Whichever sits closer to the lines the patch declares
wins, and a tie counts as applied. This matters for a patch that once landed at an
offset — checking only the declared position would never recognise it again, and
`apply` in a `postinstall` hook would lay it down anew on every install, appending
its changes over and over.

## File permissions

A change to a file's executable bit is captured and restored, including for files
the patch creates. It is recorded with the same git headers `patch-package` uses:

```diff
diff --git a/node_modules/some-package/bin/run.sh b/node_modules/some-package/bin/run.sh
old mode 100644
new mode 100755
```

Only the executable bit is tracked, the way git does it — comparing full permission
bits would report differences that are really just a different umask.

On Windows there is no executable bit to track. A patch carrying a mode change still
applies there — the mode part is skipped rather than attempted, so the patch counts
as applied once and stays that way instead of being reported as work on every run.

## Platforms

Checked against 290 patches taken from public repositories, applied with both this
tool and `patch-package` and compared byte for byte: all 290 trees are identical,
and the two tools agree on the exit code every time.

Tested on Linux, macOS and Windows. `apply` is plain JavaScript and needs nothing
from the system; `create` shells out to `diff`, which is present on all three
(on Windows it comes with Git).

The `bun >= 1.0.0` in `engines` is checked rather than assumed: CI applies a patch,
re-applies it, reads `status` and un-applies it on bun 1.0, 1.1 and 1.2, alongside
the full suite on the current release. Developing the tool needs bun 1.2 or newer,
though — the text lockfile and the test runner it uses arrived there.

If `diff` is not on PATH, `create` says so before it does anything else, rather
than downloading a pristine copy of the package first and failing afterwards.

## Example

```bash
# Install a package
bun add react-native-date-picker

# Make changes to fix a bug
code node_modules/react-native-date-picker/ios/RNDatePicker.h

# Create patch
bunx bunch-package create react-native-date-picker
# ✅ Patch created: patches/react-native-date-picker+5.0.13.patch
# 📊 Stats:
#    Lines: 13
#    Size: 1.11 KB

# Add to package.json
{
  "scripts": {
    "postinstall": "bunx bunch-package apply"
  }
}

# Commit
git add patches/
git commit -m "fix: add missing include in react-native-date-picker"
```

## How it works

1. **Create** fetches a pristine copy of the package into a temp directory, diffs it
   against your modified version, and writes the diff as a patch file.
2. **Apply** applies every `.patch` file in `patches/` itself, without shelling out
   to `patch(1)`: one run at a time, each file replaced rather than rewritten in
   place, and a record of what landed left in `node_modules`.

Unified diffs are parsed and applied in process. That is a deliberate choice: `patch`
is GNU on Linux and a much older Apple build on macOS, and they disagree on exit
codes, on the wording of their diagnostics, and on whether a patch is allowed to
write outside the project at all. Doing it in process also makes the whole patch
atomic, keeps deletions idempotent, and means paths are checked against the project
root by us rather than by whichever `patch` happens to be installed.

Whether a patch is already in the tree is never taken on faith from that record —
it is worked out from the files, by reading them both ways: how well the hunks' old
side fits, and how well the new side fits. That is what makes a second `apply` a
no-op even for a patch that landed at an offset.

The pristine copy is installed with a download cache of its own, and copied out of
it rather than linked. This matters: bun links installed packages to its shared
cache, so editing a file in `node_modules` edits the cache entry too — and a "clean"
install pulled from that cache would come back carrying your change, making the diff
come out empty. Our own cache is never written to, which is checked by a test rather
than assumed: patches are replayed onto the pristine copy, and the cache has to come
out of that byte for byte the same.

Patch headers are rebuilt from the file paths rather than rewritten in place, so an
absolute path that happens to appear *inside* a file is left alone.

## Compared with patch-package

Patch files are interchangeable between the two, and on real patches the result is
the same. Everything below was measured by running both, not assumed:

| | bunch-package | patch-package 8.0.1 |
|---|---|---|
| Result on 290 real patches | identical trees, identical exit codes | identical trees, identical exit codes |
| `apply` on a 3-section patch | 15 ms | 71 ms |
| `apply` on a 35-section patch | 22 ms | 76 ms |
| Applying a patch that only appends lines, three times | applied once, then recognised | 1, then 2, then 3 copies of the added lines |
| Patch section describing a symlink (`mode 120000`) | refused, and named as a symlink | refused as "could not be parsed" |
| Record of what was applied | `node_modules/.bunch-package-state.json` | `.patch-package.json`, written inside the patched package |
| Bun's shared install cache | handled | not addressed — its README does not mention bun |
| npm, yarn, pnpm, workspaces | not attempted | documented |
| Moving a patch to a newer version of the package | `retarget` | — |

Most of the speed difference is process startup, which is what a `postinstall` hook
pays on every install. The rest of the table is a difference in behaviour, not a
score: `patch-package` runs where this tool does not, and that is the honest reason
to keep using it.

## Alongside `bun patch`

bun has patched packages itself since 1.2: `bun patch --commit` writes a patch into
the same `patches/` directory and records it under `patchedDependencies` in
`package.json`, and the installer applies it — no `postinstall` involved. Those
patches are written differently: the file is named `ms@2.1.2.patch`, and the paths
inside it are relative to the package root (`a/index.js`), not to the project
(`a/node_modules/ms/index.js`).

This tool leaves them alone. `apply` skips anything listed in `patchedDependencies`
and says who owns it; `status` lists those separately rather than counting them;
and a patch whose paths are not under `node_modules/` is refused out loud, because
applying it as if the paths were ours would write into the project's own files.
`create` refuses a package bun already patches, since bun's patch is in
`node_modules` but not in the pristine copy and would end up inside the new patch.

What the two tools do is not the same job. Measured on bun 1.4.0: `bun install`
applies a patch by line number without checking the lines it claims to remove — a
hunk deleting a line that is not in the file still rewrites whatever sits at that
position, silently, exit code 0 — and when the installed version no longer matches
the `patchedDependencies` key, the patch is quietly not applied at all, with nothing
in the output to say so. There is one patch per package, regenerated whole. This
tool refuses instead of guessing, warns when the version drifts, moves patches to a
new version with `retarget`, keeps a sequence of patches per package, and can tell
you what is in the tree right now.

## Requirements

- **Using it:** bun >= 1.0.0, checked in CI on 1.0, 1.1 and 1.2 as well as the
  current release. `create` also needs `diff` on PATH.
- **Working on it:** bun >= 1.2 — the text lockfile and the test runner the suite
  uses arrived there.

## License

MIT

## Contributing

Issues and PRs welcome!