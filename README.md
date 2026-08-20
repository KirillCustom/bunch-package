# bunch-package

> Patch management tool for Bun - alternative to patch-package

`bunch-package` lets you fix broken node_modules instantly and persist the changes through `postinstall` scripts. It's like `patch-package` but optimized for Bun.

## Why bunch-package?

- 🚀 **Fast** - Built specifically for Bun
- 🎯 **Simple** - Two commands: create and apply
- 🔒 **Safe** - Automatically excludes binary files and build artifacts
- 📦 **Smart** - Detects already applied patches
- 🎨 **Clean patches** - Excludes build directories, binaries, and media files

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

### Create a patch

```bash
bunx bunch-package create <package-name>
```

Example:
```bash
bunx bunch-package create react-native-date-picker
```

### Apply all patches

```bash
bunx bunch-package apply
```

Applies all patches from the `patches/` directory.

A patch counts as applied only when its changes are actually in the tree. The whole
patch is computed in memory first, and nothing is written unless every file in it
fits — so a patch can never leave your tree half-changed, and a failed apply leaves
no `.rej` or `.orig` files behind. Applying the same patch twice is a no-op.

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Every patch is in the tree (applied now or already applied) |
| `1` | At least one patch failed — the reason is printed under it, and nothing was written |

A non-zero exit makes `postinstall` fail, so a broken patch stops CI instead of
silently shipping an unpatched build.

Patches created by bunch-package before 1.1.0 contain absolute paths and cannot be
applied; `apply` reports them as failed and asks you to recreate them with `create`.

## What gets excluded?

`bunch-package` automatically excludes, at any depth:

- Binary files (`*.so`, `*.jar`, `*.aar`, `*.class`, `*.dex`, `*.apk`, `*.a`, `*.framework`, `*.xcframework`, `*.dylib`)
- Media files (`*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`)
- Fonts (`*.ttf`, `*.otf`, `*.woff`, `*.woff2`)
- Leftovers from a failed apply (`*.rej`, `*.orig`)
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
applies there, the mode part is simply ignored — nothing fails.

## Platforms

Tested on Linux, macOS and Windows. `apply` is plain JavaScript and needs nothing
from the system; `create` shells out to `diff`, which is present on all three
(on Windows it comes with Git).

This keeps your patches small and text-based.

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

1. **Create**: Fetches a pristine copy of the package into a temp directory, diffs it against your modified version, and writes the diff as a patch file
2. **Apply**: Applies every `.patch` file in `patches/` itself, without shelling out to `patch(1)`

Unified diffs are parsed and applied in process. That is a deliberate choice: `patch`
is GNU on Linux and a much older Apple build on macOS, and they disagree on exit
codes, on the wording of their diagnostics, and on whether a patch is allowed to
write outside the project at all. Doing it in process also makes the whole patch
atomic, keeps deletions idempotent, and means paths are checked against the project
root by us rather than by whichever `patch` happens to be installed.

The pristine copy is installed with an isolated download cache. This matters: bun
links installed packages to its shared cache, so editing a file in `node_modules`
edits the cache entry too — and a "clean" install pulled from that cache would come
back carrying your change, making the diff come out empty. Patch headers are rebuilt
from the file paths rather than rewritten in place, so an absolute path that happens
to appear *inside* a file is left alone.

## Comparison with patch-package

| Feature | bunch-package | patch-package |
|---------|--------------|---------------|
| Speed | ⚡️ Fast (Bun) | Slower (Node.js) |
| Binary exclusion | ✅ Automatic | ⚠️ Manual config |
| Already applied detection | ✅ Smart | ⚠️ Can fail |
| Size | 📦 Small (~200 lines) | 📦 Larger |

## Requirements

- Bun >= 1.0.0

## License

MIT

## Contributing

Issues and PRs welcome!