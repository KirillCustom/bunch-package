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

## What gets excluded?

`bunch-package` automatically excludes:

- Build artifacts (`build/`, `.gradle/`, `.transforms/`, `Pods/`, `DerivedData/`)
- Binary files (`*.so`, `*.jar`, `*.aar`, `*.class`, `*.dex`, `*.apk`, `*.a`, `*.framework`, `*.xcframework`, `*.dylib`)
- Media files (`*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`)
- Fonts (`*.ttf`, `*.otf`, `*.woff`, `*.woff2`)
- Version control (`.git/`, `node_modules/`)

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

1. **Create**: Installs a clean version of the package in a temp directory, diffs it with your modified version, and saves the diff as a patch file
2. **Apply**: Uses the `patch` command to apply all `.patch` files in the `patches/` directory

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