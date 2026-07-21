#!/bin/sh
set -e

# GJC local build installer (clone & build from source)
#
# Use this when no prebuilt standalone binary is published for your platform
# (for example Intel/x86_64 macOS) or when you simply want to run gjc from a
# source checkout. It clones the repo (or reuses an existing checkout), installs
# Bun if needed, builds the native addon, and links the `gjc` command onto your
# PATH so it runs this checkout's source.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install_local_build.sh | sh
#
# Options:
#   --dir <path>   Directory to clone into (default: $HOME/.gajae-code/src)
#   --ref <ref>    Checkout a specific tag/branch/commit after cloning
#   -r <ref>       Shorthand for --ref
#   --no-link      Build only; skip linking `gjc` onto PATH
#
# Environment:
#   GJC_SRC_DIR        Overrides the default clone directory
#   GJC_DEV_LINK_DIR   Directory dev:link installs the `gjc` symlink into

REPO="Yeachan-Heo/gajae-code"
REPO_URL="https://github.com/${REPO}.git"
MIN_BUN_VERSION="1.3.14"

SRC_DIR="${GJC_SRC_DIR:-$HOME/.gajae-code/src}"
REF=""
DO_LINK="1"

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)
            SRC_DIR="$2"
            shift 2
            ;;
        --ref|-r)
            REF="$2"
            shift 2
            ;;
        --no-link)
            DO_LINK=""
            shift
            ;;
        -h|--help)
            awk 'NR==1{next} /^#/{line=$0;sub(/^# ?/,"",line);print line;started=1;next} started{exit}' "$0"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

has_cmd() {
    command -v "$1" >/dev/null 2>&1
}

# Compare two dotted versions; succeeds when $1 >= $2.
version_ge() {
    [ "$1" = "$2" ] && return 0
    lower="$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)"
    [ "$lower" = "$2" ]
}

install_bun() {
    echo "Installing Bun..."
    if ! has_cmd curl; then
        echo "curl is required to install Bun. Install curl and re-run." >&2
        exit 1
    fi
    curl -fsSL https://bun.sh/install | bash
    # Make bun available in this shell session.
    BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export BUN_INSTALL
    export PATH="$BUN_INSTALL/bin:$PATH"
}

require_bun() {
    if ! has_cmd bun; then
        install_bun
    fi
    if ! has_cmd bun; then
        echo "Bun install did not put 'bun' on PATH. Restart your shell and re-run." >&2
        exit 1
    fi
    current="$(bun --version 2>/dev/null | head -n1)"
    if [ -n "$current" ] && ! version_ge "$current" "$MIN_BUN_VERSION"; then
        echo "Bun $current is older than the required $MIN_BUN_VERSION. Upgrade with 'bun upgrade' and re-run." >&2
        exit 1
    fi
}

# --- Preconditions --------------------------------------------------------
if ! has_cmd git; then
    echo "git is required to clone the repository. Install git and re-run." >&2
    exit 1
fi

# --- Clone or update the checkout ----------------------------------------
if [ -d "$SRC_DIR/.git" ]; then
    echo "Updating existing checkout at $SRC_DIR..."
    git -C "$SRC_DIR" fetch --tags origin
    if [ -z "$REF" ]; then
        git -C "$SRC_DIR" pull --ff-only
    fi
else
    echo "Cloning $REPO into $SRC_DIR..."
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone "$REPO_URL" "$SRC_DIR"
fi

if [ -n "$REF" ]; then
    echo "Checking out $REF..."
    git -C "$SRC_DIR" checkout "$REF"
fi

cd "$SRC_DIR"

# --- Build ----------------------------------------------------------------
require_bun

echo "Installing dependencies..."
bun install --frozen-lockfile

echo "Building native addon..."
bun run build:native

if [ -n "$DO_LINK" ]; then
    echo "Linking gjc onto PATH..."
    bun run dev:link
    echo ""
    echo "✓ gjc is now linked to the source checkout at $SRC_DIR"
    echo "  Run 'gjc --version' to verify, or 'bun run dev:doctor' if it misbehaves."
else
    echo ""
    echo "✓ Build complete at $SRC_DIR"
    echo "  Run from source with: bun $SRC_DIR/packages/coding-agent/src/cli.ts --help"
    echo "  Or link later with:   bun --cwd $SRC_DIR run dev:link"
fi
