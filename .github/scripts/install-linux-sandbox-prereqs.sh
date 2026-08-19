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
set -euo pipefail

readonly ATTEMPTS=3
readonly UPDATE_BUDGET=90
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

# run_apt BUDGET_SECONDS LABEL ARGS...
run_apt() {
  local budget="$1" label="$2"
  shift 2

  local attempt status
  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    echo "::group::${label} (attempt ${attempt}/${ATTEMPTS}, ${budget}s budget)"
    status=0
    sudo DEBIAN_FRONTEND=noninteractive \
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
    sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true
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
