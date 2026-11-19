#!/usr/bin/env bash
# Back up git repos as verified, restorable bundles (all refs), with a manifest of commits and sha256.
# usage: backup-bundle.sh <out-dir> <repo>...      selftest: backup-bundle.sh selftest
# Only tracked history goes in: untracked and ignored files (keystores, local.properties, node_modules) never do.
# Restorability is proven, not assumed: each bundle is cloned into a temp dir and its HEAD compared with the repo's.
# git LFS: a bundle carries only the pointer files. A repo with LFS objects also gets <name>-...-lfs.tar (its .git/lfs/objects;
# shortcut: full every time, not incremental; fine at a few hundred MB, upgrade when it reaches GBs). The restore test clones
# the bundle, unpacks the tar, checks every object hashes to its name, every object of every ref is there, and every LFS file
# of HEAD holds real content whose sha256 is its oid (a leftover pointer file would otherwise look restored).
set -euo pipefail

bundle_one() { # <out-dir> <repo> -> prints "name head sha256 bytes file" (plus a "<name>-lfs" line for the LFS tar)
  local out=$1 repo=$2 name head stamp file tmp got lfs=""
  name=$(basename "$repo"); head=$(git -C "$repo" rev-parse HEAD); stamp=$(date -u +%Y%m%dT%H%MZ)
  file="$out/$name-$stamp-${head:0:8}.bundle"
  git -C "$repo" bundle create "$file" --all >/dev/null 2>&1
  git -C "$repo" bundle verify "$file" >/dev/null 2>&1 || { echo "verify failed: $file" >&2; return 1; }
  if [ -n "$(git -C "$repo" lfs ls-files --all 2>/dev/null | head -1)" ]; then
    lfs="$out/$name-$stamp-${head:0:8}-lfs.tar"; tar --force-local -C "$repo/.git/lfs" -cf "$lfs" objects
  fi
  tmp=$(mktemp -d); GIT_LFS_SKIP_SMUDGE=1 git clone -q "$file" "$tmp/r" 2>/dev/null
  got=$(git -C "$tmp/r" rev-parse HEAD)
  [ "$got" = "$head" ] || { rm -rf "$tmp"; echo "restore HEAD $got != $head for $name" >&2; return 1; }
  if [ -n "$lfs" ] && ! lfs_restore_check "$tmp/r" "$lfs" "$repo"; then rm -rf "$tmp"; echo "LFS restore failed for $name" >&2; return 1; fi
  rm -rf "$tmp"
  echo "$name $head $(sha256sum "$file" | cut -c1-64) $(stat -c %s "$file") $file"
  [ -z "$lfs" ] || echo "$name-lfs $head $(sha256sum "$lfs" | cut -c1-64) $(stat -c %s "$lfs") $lfs"
}

lfs_restore_check() { # <clone> <lfs.tar> <original repo>
  local r=$1 tar=$2 orig=$3 bad=0 n=0 m=0 oid f line
  mkdir -p "$r/.git/lfs" && tar --force-local -C "$r/.git/lfs" -xf "$tar"
  while IFS= read -r f; do n=$((n + 1)); [ "$(sha256sum "$f" | cut -c1-64)" = "$(basename "$f")" ] || { echo "corrupt object $f" >&2; bad=1; }; done \
    < <(find "$r/.git/lfs/objects" -type f)
  while read -r oid; do [ -f "$r/.git/lfs/objects/${oid:0:2}/${oid:2:2}/$oid" ] || { echo "missing object $oid" >&2; bad=1; }; done \
    < <(git -C "$orig" lfs ls-files --all --long | cut -d' ' -f1 | sort -u)
  git -C "$r" lfs install --local >/dev/null && git -C "$r" lfs checkout >/dev/null 2>&1 || true
  while IFS= read -r line; do # "<oid> <*|-> <path>"
    m=$((m + 1)); oid=${line%% *}; f=${line:67}
    [ "$(sha256sum "$r/$f" | cut -c1-64)" = "$oid" ] || { echo "not restored: $f" >&2; bad=1; }
  done < <(git -C "$r" lfs ls-files --long)
  echo "lfs restore: $n objects hash-true, $m HEAD files hold their content" >&2
  return $bad
}

if [ "${1:-}" = selftest ]; then
  t=$(mktemp -d); git init -q "$t/demo"; git -C "$t/demo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
  echo secret > "$t/demo/key.jks"; mkdir "$t/out"
  line=$(bundle_one "$t/out" "$t/demo"); f=${line##* }
  git clone -q "$f" "$t/check"; [ ! -e "$t/check/key.jks" ] || { echo "untracked file leaked"; exit 1; }
  # LFS repo: the tar comes out and restores; a corrupted object is caught
  git init -q "$t/lfs"; git -C "$t/lfs" lfs install --local >/dev/null; git -C "$t/lfs" lfs track '*.bin' >/dev/null
  head -c 5000 /dev/urandom > "$t/lfs/a b.bin"; git -C "$t/lfs" add -A; git -C "$t/lfs" -c user.name=t -c user.email=t@t commit -q -m lfs
  out=$(bundle_one "$t/out" "$t/lfs" 2>/dev/null); tarf=$(echo "$out" | awk '$1 == "lfs-lfs" {print $5}')
  [ -f "$tarf" ] || { echo "no LFS tar"; exit 1; }
  obj=$(find "$t/lfs/.git/lfs/objects" -type f | head -1); chmod u+w "$obj"; echo x >> "$obj"
  if bundle_one "$t/out" "$t/lfs" >/dev/null 2>&1; then echo "corrupt LFS object not caught"; exit 1; fi
  rm -rf "$t"; echo "backup-bundle selftest ok"; exit 0
fi

out=${1:?usage: backup-bundle.sh <out-dir> <repo>...}; shift; mkdir -p "$out"
manifest="$out/BACKUP-$(date -u +%Y%m%dT%H%MZ).txt"
for repo in "$@"; do bundle_one "$out" "$repo"; done | tee "$manifest"
echo "manifest: $manifest"
