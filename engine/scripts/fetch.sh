#!/usr/bin/env bash
# Récupère les sources OpenTTD épinglées dans engine/upstream/.
#
# - idempotent : ne retélécharge pas si l'archive et l'extraction sont valides ;
# - vérifie le SHA256 publié par OpenTTD (engine/upstream.lock) ;
# - ne committe jamais les sources (engine/upstream/ est gitignoré).
#
# Usage : bash engine/scripts/fetch.sh [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${ENGINE_DIR}/.." && pwd)"

# shellcheck source=../upstream.lock
source "${ENGINE_DIR}/upstream.lock"

CACHE_DIR="${ENGINE_DIR}/.cache"
UPSTREAM_DIR="${ENGINE_DIR}/upstream"
ARCHIVE="${CACHE_DIR}/openttd-${OPENTTD_VERSION}-source.tar.xz"
SRC_DIR="${UPSTREAM_DIR}/openttd-${OPENTTD_VERSION}"
STAMP="${SRC_DIR}/.openttd-source.sha256"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

log() { printf '\033[1;34m[fetch]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[fetch] erreur:\033[0m %s\n' "$*" >&2; exit 1; }

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

mkdir -p "${CACHE_DIR}" "${UPSTREAM_DIR}"

if [[ ${FORCE} -eq 0 && -f "${STAMP}" && -d "${SRC_DIR}" ]]; then
  if [[ "$(cat "${STAMP}")" == "${OPENTTD_SOURCE_SHA256}" ]]; then
    log "OpenTTD ${OPENTTD_VERSION} déjà extrait et vérifié dans ${SRC_DIR}"
    exit 0
  fi
  log "empreinte locale différente, réextraction"
fi

# 1. Téléchargement (ou réutilisation du cache valide).
if [[ -f "${ARCHIVE}" ]] && [[ "$(sha256_file "${ARCHIVE}")" == "${OPENTTD_SOURCE_SHA256}" ]]; then
  log "archive déjà en cache : ${ARCHIVE}"
else
  log "téléchargement de ${OPENTTD_SOURCE_URL}"
  tmp_dl="${ARCHIVE}.part"
  curl --fail --location --retry 3 --retry-delay 2 --output "${tmp_dl}" "${OPENTTD_SOURCE_URL}"
  mv "${tmp_dl}" "${ARCHIVE}"
fi

# 2. Vérification d'intégrité.
actual="$(sha256_file "${ARCHIVE}")"
if [[ "${actual}" != "${OPENTTD_SOURCE_SHA256}" ]]; then
  rm -f "${ARCHIVE}"
  die "SHA256 invalide pour ${ARCHIVE} (attendu ${OPENTTD_SOURCE_SHA256}, obtenu ${actual})"
fi
log "SHA256 OK (${actual})"

# 3. Extraction atomique : on extrait dans un dossier temporaire puis on
#    remplace l'ancienne copie. `xz` est disponible sur macOS et Linux.
tmp_dir="${UPSTREAM_DIR}/.extract-$$"
rm -rf "${tmp_dir}"
mkdir -p "${tmp_dir}"
log "extraction vers ${SRC_DIR}"
tar -xJf "${ARCHIVE}" -C "${tmp_dir}"
extracted="$(find "${tmp_dir}" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
[[ -n "${extracted}" ]] || die "archive inattendue : aucun dossier racine"

rm -rf "${SRC_DIR}"
mv "${extracted}" "${SRC_DIR}"
rm -rf "${tmp_dir}"
printf '%s\n' "${OPENTTD_SOURCE_SHA256}" > "${STAMP}"

log "terminé : $(cd "${SRC_DIR}" && pwd)"
log "version : $(grep -m1 '^#define VERSION' "${SRC_DIR}/src/rev.cpp.in" 2>/dev/null || echo "${OPENTTD_VERSION}")"
