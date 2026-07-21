#!/bin/sh
set -e

# GJC local build installer (clone & build from source)
#
# Use this when no prebuilt standalone binary is published for your platform
# (for example Intel/x86_64 macOS) or when you simply want to run gjc from a
# source checkout.
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
PROMOTION_STATUS_DIR=""
REUSED_CHECKOUT=""
ORIGINAL_HEAD=""
ORIGINAL_REF=""
PROMOTION_MARKER=""
PROMOTION_TOKEN=""

remove_owned_destination() {
	if [ -n "$PROMOTION_MARKER" ] && [ -n "$PROMOTION_TOKEN" ] && [ -f "$PROMOTION_MARKER" ] && IFS= read -r marker_token < "$PROMOTION_MARKER" && [ "$marker_token" = "$PROMOTION_TOKEN" ]; then
		rm -rf "$DEST_DIR" || echo "cleanup: could not remove the failed destination claim." >&2
	fi
}
cleanup() {
	status=$?
	trap - 0 HUP INT TERM
	if [ "$status" -ne 0 ] && [ -n "$REUSED_CHECKOUT" ] && [ -n "$ORIGINAL_HEAD" ]; then
		if [ -n "$ORIGINAL_REF" ]; then
			git -C "$SRC_DIR" checkout --quiet "$ORIGINAL_REF" || echo "cleanup: could not restore the reused checkout." >&2
		else
			git -C "$SRC_DIR" checkout --quiet --detach "$ORIGINAL_HEAD" || echo "cleanup: could not restore the reused checkout." >&2
		fi
	fi
	if [ "$status" -ne 0 ]; then remove_owned_destination; fi
	[ -z "$TEMP_CLONE" ] || rm -rf "$TEMP_CLONE"
	[ -z "$TEMP_BUN_INSTALLER" ] || rm -f "$TEMP_BUN_INSTALLER"
	if [ -n "$PROMOTION_STATUS_DIR" ] && ! rm -rf "$PROMOTION_STATUS_DIR"; then echo "cleanup: could not remove temporary copy-status files." >&2; fi
	exit "$status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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

# Every pathname passed to filesystem utilities is quoted. Reject leading dashes
# as well: POSIX utilities do not consistently support an end-of-options marker.
validate_destination() {
	case "$1" in
		""|-*) fail "argument parsing" "Destination must not be empty or start with '-'." ;;
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
validate_destination "$SRC_DIR"

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

save_reused_checkout() {
	if ! git -C "$SRC_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		fail "destination validation" "Destination is not a Git worktree: $SRC_DIR"
	fi
	if ! checkout_root=$(git -C "$SRC_DIR" rev-parse --show-toplevel); then
		fail "destination validation" "Could not determine the existing checkout root."
	fi
	if ! requested_dir=$(CDPATH= cd "$SRC_DIR" && pwd -P); then
		fail "destination validation" "Could not canonicalize the existing checkout path."
	fi
	if ! checkout_root=$(CDPATH= cd "$checkout_root" && pwd -P); then
		fail "destination validation" "Could not canonicalize the existing checkout root."
	fi
	[ "$requested_dir" = "$checkout_root" ] || fail "destination validation" "Destination must be the existing checkout root: $SRC_DIR"
	SRC_DIR=$requested_dir
	if ! origin=$(git -C "$SRC_DIR" config --get remote.origin.url); then fail "destination validation" "Could not read the existing checkout origin."; fi
	[ "$origin" = "$REPO_URL" ] || fail "destination validation" "Existing checkout does not have the expected origin."
	if ! worktree_status=$(git -C "$SRC_DIR" status --porcelain); then fail "destination validation" "Could not verify the existing checkout state."; fi
	[ -z "$worktree_status" ] || fail "destination validation" "Existing checkout is not clean."
	ORIGINAL_HEAD=$(git -C "$SRC_DIR" rev-parse --verify HEAD) || fail "destination validation" "Could not record the existing checkout commit."
	ORIGINAL_REF=$(git -C "$SRC_DIR" symbolic-ref -q HEAD || true)
	REUSED_CHECKOUT=1
}

prepare_checkout() {
	if [ -e "$SRC_DIR" ]; then
		if [ -d "$SRC_DIR" ] && git -C "$SRC_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
			save_reused_checkout
			echo "Updating verified checkout at $SRC_DIR..."
			run_git "fetch" -C "$SRC_DIR" fetch --tags origin
			checkout_commit
			return
		fi
		if [ -d "$SRC_DIR" ] && is_empty_dir "$SRC_DIR"; then
			rmdir "$SRC_DIR" || fail "destination preparation" "Could not remove empty destination $SRC_DIR."
		else
			fail "destination validation" "Destination exists and is not an empty Git checkout: $SRC_DIR"
		fi
	fi

	parent=$(dirname "$SRC_DIR")
	mkdir -p "$parent" || fail "destination preparation" "Could not create $parent."
	TEMP_CLONE=$(mktemp -d "$parent/.gajae-code.clone.XXXXXX") || fail "clone preparation" "Could not create a temporary sibling checkout."
	echo "Cloning $REPO into $SRC_DIR..."
	run_git "clone" clone "$REPO_URL" "$TEMP_CLONE"
	if ! origin=$(git -C "$TEMP_CLONE" remote get-url origin); then fail "clone validation" "Could not read the temporary checkout origin."; fi
	[ "$origin" = "$REPO_URL" ] || fail "clone validation" "Temporary checkout does not have the expected origin."
	SRC_DIR=$TEMP_CLONE
	run_git "fetch" -C "$SRC_DIR" fetch --tags origin
	checkout_commit
}

promote_clone() {
	# Claim the final directory exclusively before copying. A unique marker proves
	# that a failed copy may roll back only this invocation's claim; an existing or
	# concurrently-created destination is never removed.
	PROMOTION_STATUS_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gjc-promotion.XXXXXX") || fail "promotion" "Could not create temporary copy-status files."
	# mktemp's generated basename is independent of the clone path and contains no
	# line delimiters, so the marker remains a single, comparable record even when
	# a destination parent includes a newline.
	PROMOTION_TOKEN=${PROMOTION_STATUS_DIR##*/}
	PROMOTION_MARKER="$DEST_DIR/.gajae-code-install-owner"
	if ! mkdir "$DEST_DIR"; then
		fail "promotion" "Destination appeared while preparing the clone; it was left untouched: $DEST_DIR"
	fi
	if ! printf '%s\n' "$PROMOTION_TOKEN" > "$PROMOTION_MARKER"; then
		# mkdir claimed this empty path exclusively. rmdir avoids recursively deleting
		# anything if another process has since populated or replaced it.
		rmdir "$DEST_DIR" || echo "cleanup: could not remove the empty destination claim." >&2
		fail "promotion" "Could not mark the claimed destination."
	fi
	promotion_status_valid=1
	if (
		if cd "$TEMP_CLONE"; then
			if tar cf - .; then producer_status=0; else producer_status=$?; fi
		else
			producer_status=$?
		fi
		printf '%s\n' "$producer_status" > "$PROMOTION_STATUS_DIR/producer" || exit 1
	) | (
		if cd "$DEST_DIR"; then
			if tar xpf -; then extractor_status=0; else extractor_status=$?; fi
		else
			extractor_status=$?
		fi
		printf '%s\n' "$extractor_status" > "$PROMOTION_STATUS_DIR/extractor" || exit 1
	); then
		:
	else
		promotion_status_valid=
	fi
	if [ -f "$PROMOTION_STATUS_DIR/producer" ] && IFS= read -r producer_status < "$PROMOTION_STATUS_DIR/producer"; then
		case "$producer_status" in ""|*[!0-9]*) promotion_status_valid= ;; esac
	else
		promotion_status_valid=
	fi
	if [ -f "$PROMOTION_STATUS_DIR/extractor" ] && IFS= read -r extractor_status < "$PROMOTION_STATUS_DIR/extractor"; then
		case "$extractor_status" in ""|*[!0-9]*) promotion_status_valid= ;; esac
	else
		promotion_status_valid=
	fi
	if ! rm -rf "$PROMOTION_STATUS_DIR"; then
		remove_owned_destination
		fail "promotion" "Could not clean up temporary copy-status files."
	fi
	PROMOTION_STATUS_DIR=""
	if [ -z "$promotion_status_valid" ] || [ "$producer_status" != 0 ] || [ "$extractor_status" != 0 ]; then
		remove_owned_destination
		fail "promotion" "Could not populate the claimed destination."
	fi
	if ! rm -f "$PROMOTION_MARKER"; then
		remove_owned_destination
		fail "promotion" "Could not finalize the claimed destination."
	fi
	rm -rf "$TEMP_CLONE"
	TEMP_CLONE=""
	SRC_DIR=$DEST_DIR
}

DEST_DIR=$SRC_DIR
if ! has_cmd git; then fail "preconditions" "git is required to clone the repository. Install git and re-run."; fi
prepare_checkout
if [ -n "$TEMP_CLONE" ]; then promote_clone; fi

cd "$SRC_DIR" || fail "build preparation" "Could not enter $SRC_DIR."
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
