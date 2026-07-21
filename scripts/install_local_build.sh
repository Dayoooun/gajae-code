#!/bin/sh
set -e

# GJC local build installer (clone & build from source)
#
# Use this when no prebuilt standalone binary is published for your platform
# (for example Intel/x86_64 macOS) or when you simply want to run gjc from a
# source checkout.
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
DO_LINK=1
TEMP_CLONE=""
TEMP_BUN_INSTALLER=""
CREATED_DEST=""

cleanup() {
	status=$?
	trap - 0 HUP INT TERM
	[ -z "$TEMP_CLONE" ] || rm -rf "$TEMP_CLONE"
	[ "$status" -eq 0 ] || [ -z "$CREATED_DEST" ] || rm -rf "$CREATED_DEST"
	[ -z "$TEMP_BUN_INSTALLER" ] || rm -f "$TEMP_BUN_INSTALLER"
	exit "$status"
}
trap cleanup 0 HUP INT TERM

fail() {
	echo "$1: $2" >&2
	exit 1
}

fail_status() {
	status=$1
	shift
	echo "$1: $2 (exit $status)." >&2
	exit "$status"
}

has_cmd() {
	command -v "$1" >/dev/null 2>&1
}

require_value() {
	[ $# -ge 2 ] || fail "argument parsing" "Option $1 requires a value."
}

validate_ref() {
	case "$1" in
		""|-*|*[[:space:]]*) fail "argument parsing" "Ref must not be empty, start with '-', or contain whitespace." ;;
	esac
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dir)
			require_value "$@"
			SRC_DIR=$2
			shift 2
			;;
		--ref|-r)
			require_value "$@"
			validate_ref "$2"
			REF=$2
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
		*) fail "argument parsing" "Unknown option: $1" ;;
	esac
done

# Compare two dotted versions; succeeds when $1 >= $2.
version_ge() {
	[ "$1" = "$2" ] && return 0
	lower=$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)
	[ "$lower" = "$2" ]
}

install_bun() {
	echo "Installing Bun..."
	has_cmd curl || fail "Bun installation" "curl is required to install Bun. Install curl and re-run."
	has_cmd bash || fail "Bun installation" "bash is required to run the Bun installer. Install bash and re-run."
	TEMP_BUN_INSTALLER=$(mktemp "${TMPDIR:-/tmp}/gjc-bun-install.XXXXXX") || fail "Bun installation" "Could not create a temporary installer file."
	if curl -fsSL https://bun.sh/install -o "$TEMP_BUN_INSTALLER"; then
		:
	else
		status=$?
		fail_status "$status" "Bun download" "Could not download the Bun installer"
	fi
	if bash "$TEMP_BUN_INSTALLER"; then
		:
	else
		status=$?
		fail_status "$status" "Bun installation" "The Bun installer failed"
	fi
	BUN_INSTALL=${BUN_INSTALL:-$HOME/.bun}
	export BUN_INSTALL
	export PATH="$BUN_INSTALL/bin:$PATH"
}

require_bun() {
	if ! has_cmd bun; then
		install_bun
	fi
	if ! has_cmd bun; then
		fail "Bun verification" "Bun is not on PATH after installation."
	fi
	current=$(bun --version 2>/dev/null | head -n1)
	case "$current" in
		""|*[!0123456789.]*) fail "Bun verification" "Bun reported an invalid version: ${current:-unknown}." ;;
	esac
	if ! version_ge "$current" "$MIN_BUN_VERSION"; then
		fail "Bun verification" "Bun $current is older than the required $MIN_BUN_VERSION."
	fi
}

run_git() {
	phase=$1
	shift
	if git "$@"; then
		return 0
	else
		status=$?
		echo "$phase failed (exit $status)." >&2
		return "$status"
	fi
}

resolve_commit() {
	if [ -n "$REF" ]; then
		target=$REF
	else
		target=refs/remotes/origin/HEAD
	fi
	if ! commit=$(git -C "$SRC_DIR" rev-parse --verify --quiet --end-of-options "${target}^{commit}"); then
		fail "ref resolution" "Could not resolve '$target' to a commit."
	fi
	case "$commit" in
		*[!0123456789abcdef]*) fail "ref resolution" "Git returned an invalid commit ID." ;;
	esac
	printf '%s\n' "$commit"
}

checkout_commit() {
	commit=$(resolve_commit)
	echo "Checking out $commit..."
	run_git "checkout" -C "$SRC_DIR" checkout --detach "$commit"
}

is_empty_dir() {
	for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
		[ -e "$entry" ] && return 1
	done
	return 0
}

prepare_checkout() {
	if [ -e "$SRC_DIR" ]; then
		if [ ! -d "$SRC_DIR/.git" ]; then
			if [ -d "$SRC_DIR" ] && is_empty_dir "$SRC_DIR"; then
				rmdir "$SRC_DIR" || fail "destination preparation" "Could not remove empty destination $SRC_DIR."
			else
				fail "destination validation" "Destination exists and is not an empty Git checkout: $SRC_DIR"
			fi
		else
			if ! origin=$(git -C "$SRC_DIR" config --get remote.origin.url); then
				fail "destination validation" "Could not read the existing checkout origin."
			fi
			[ "$origin" = "$REPO_URL" ] || fail "destination validation" "Existing checkout does not have the expected origin."
			if ! worktree_status=$(git -C "$SRC_DIR" status --porcelain); then
				fail "destination validation" "Could not verify the existing checkout state."
			fi
			[ -z "$worktree_status" ] || fail "destination validation" "Existing checkout is not clean."
			echo "Updating verified checkout at $SRC_DIR..."
			run_git "fetch" -C "$SRC_DIR" fetch --tags origin
			checkout_commit
			return
		fi
	fi

	parent=$(dirname "$SRC_DIR")
	mkdir -p "$parent" || fail "destination preparation" "Could not create $parent."
	TEMP_CLONE=$(mktemp -d "$parent/.gajae-code.clone.XXXXXX") || fail "clone preparation" "Could not create a temporary sibling checkout."
	echo "Cloning $REPO into $SRC_DIR..."
	run_git "clone" clone "$REPO_URL" "$TEMP_CLONE"
	if ! origin=$(git -C "$TEMP_CLONE" remote get-url origin); then
		fail "clone validation" "Could not read the temporary checkout origin."
	fi
	[ "$origin" = "$REPO_URL" ] || fail "clone validation" "Temporary checkout does not have the expected origin."
	SRC_DIR=$TEMP_CLONE
	run_git "fetch" -C "$SRC_DIR" fetch --tags origin
	checkout_commit
}

# Preserve the parsed destination while prepare_checkout temporarily uses TEMP_CLONE.
DEST_DIR=$SRC_DIR

if ! has_cmd git; then
	fail "preconditions" "git is required to clone the repository. Install git and re-run."
fi

# --- Clone or update the checkout ----------------------------------------
prepare_checkout
# prepare_checkout resolves in the temporary clone; promote it only after all
# clone, fetch, and checkout operations succeeded.
if [ -n "$TEMP_CLONE" ]; then
	SRC_DIR=$DEST_DIR
	mv "$TEMP_CLONE" "$SRC_DIR" || fail "promotion" "Could not promote the temporary checkout."
	TEMP_CLONE=""
	CREATED_DEST=$SRC_DIR
else
	SRC_DIR=$DEST_DIR
fi

cd "$SRC_DIR" || fail "build preparation" "Could not enter $SRC_DIR."

# --- Build ----------------------------------------------------------------
require_bun

echo "Installing dependencies..."
bun install --frozen-lockfile || fail "dependency installation" "bun install failed."

echo "Building native addon..."
bun run build:native || fail "native build" "bun run build:native failed."

if [ -n "$DO_LINK" ]; then
	echo "Linking gjc onto PATH..."
	bun run dev:link || fail "linking" "bun run dev:link failed."
	echo ""
	echo "✓ gjc is now linked to the source checkout at $SRC_DIR"
else
	echo ""
	echo "✓ Build complete at $SRC_DIR"
fi