#!/usr/bin/env bash
#
# Install the Linux sandbox prerequisites for CI and release verification.
#
# GitHub's Ubuntu runners occasionally hand apt a degraded package mirror. When
# azure.archive.ubuntu.com stops responding, apt falls back to archive.ubuntu.com
# for the release files but then stalls indefinitely on the package indexes: no
# output, no error, no timeout. Observed twice on 2026-08-19 (runs 32274197040
# and 32293421472), both inside `apt-get update`, both recovered by a plain
# rerun. Nothing was ever blocked on a dpkg lock.
#
# apt's own Acquire timeouts only bound an idle socket, so a mirror that trickles
# bytes never trips them. Every invocation therefore gets a hard wall-clock bound
# from timeout(1) plus retries: a stalled mirror costs one bounded attempt rather
# than the 360-minute job default.
#
# The budgets separate "slow but progressing" from "stalled". Seven measured runs
# on 2026-08-19 fetched the 11.4 MB index set in 3s, 39s, 41s, 48s and 71s against
# a degraded mirror, and stalled outright once; the install fetches only ~50 kB now
# that apparmor-utils is gone. 150s therefore clears the slowest real fetch twice
# over while still killing a true stall in well under three minutes.
set -euo pipefail

readonly ATTEMPTS=3
readonly UPDATE_BUDGET=150
readonly INSTALL_BUDGET=150

# Pioneer needs /usr/bin/bwrap and /sbin/apparmor_parser. apparmor_parser ships in
# `apparmor`, which the runner image already carries; `apparmor-utils` only adds
# the aa-* Python tooling that Pioneer never calls, so it is not installed here.
readonly PACKAGES=(apparmor bubblewrap)

readonly APT_OPTIONS=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o DPkg::Lock::Timeout=120
)

# The runner points apt at a mirror list whose first entry is the Azure mirror. That
# is the host that stalls: it was the only one ignored in every hang observed, while
# Ubuntu's canonical archive stayed reachable and served the recovery at ~1 MB/s. A
# retry that re-reads the unchanged list just picks the broken mirror again, so the
# first failure narrows the list for the attempts that follow.
readonly MIRROR_LIST=/etc/apt/apt-mirrors.txt
readonly FALLBACK_MIRROR=http://archive.ubuntu.com/ubuntu/
mirror_pinned=0

pin_fallback_mirror() {
  if ((mirror_pinned == 1)) || [[ ! -f "${MIRROR_LIST}" ]]; then
    return 0
  fi
  mirror_pinned=1
  echo "Pinning apt to ${FALLBACK_MIRROR} for the remaining attempts."
  echo "${FALLBACK_MIRROR}" | sudo tee "${MIRROR_LIST}" >/dev/null
}

# run_apt BUDGET_SECONDS LABEL ARGS...
run_apt() {
  local budget="$1" label="$2"
  shift 2

  local attempt status
  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    echo "::group::${label} (attempt ${attempt}/${ATTEMPTS}, ${budget}s budget)"
    status=0
    sudo env DEBIAN_FRONTEND=noninteractive \
      timeout --signal=TERM --kill-after=10s "${budget}" \
      apt-get "${APT_OPTIONS[@]}" "$@" || status=$?
    echo "::endgroup::"

    if ((status == 0)); then
      return 0
    fi

    if ((status == 124 || status == 137)); then
      echo "::warning::${label} exceeded its ${budget}s budget on attempt ${attempt}/${ATTEMPTS}."
    else
      echo "::warning::${label} failed with status ${status} on attempt ${attempt}/${ATTEMPTS}."
    fi

    if ((attempt == ATTEMPTS)); then
      echo "::error::${label} did not succeed in ${ATTEMPTS} attempts."
      return "${status}"
    fi

    # A terminated transaction can leave dpkg half-configured; recover before retrying.
    sudo env DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true
    pin_fallback_mirror
    sleep $((attempt * 5))
  done
}

run_apt "${UPDATE_BUDGET}" "package index refresh" update
run_apt "${INSTALL_BUDGET}" "sandbox package install" install -y "${PACKAGES[@]}"

# Fail here rather than deep inside the sandbox smoke test.
if ! command -v bwrap >/dev/null; then
  echo "::error::bwrap is missing after installing ${PACKAGES[*]}."
  exit 1
fi
if [[ ! -x /sbin/apparmor_parser ]]; then
  echo "::error::/sbin/apparmor_parser is missing after installing ${PACKAGES[*]}."
  exit 1
fi
