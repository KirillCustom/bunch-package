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

A patch counts as applied only when its changes are actually in the tree: before
applying, `bunch-package` checks whether the patch reverses cleanly, which is the
only reliable way to tell "already applied" from "the file was not found" — `patch`
returns the same exit code for both.

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Every patch is in the tree (applied now or already applied) |
| `1` | At least one patch failed — the reason from `patch` is printed under it |

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
2. **Apply**: Uses the `patch` command to apply all `.patch` files in the `patches/` directory

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
- `patch` command (pre-installed on macOS/Linux)

## License

MIT

## Contributing

Issues and PRs welcome!