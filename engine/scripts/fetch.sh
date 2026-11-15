#!/usr/bin/env bash
# Récupère les sources OpenTTD et le jeu de graphismes OpenGFX épinglés
# dans engine/upstream/.
#
# - idempotent : ne retélécharge pas si les archives et extractions sont valides ;
# - vérifie les SHA256 publiés par OpenTTD (engine/upstream.lock) ;
# - ne committe jamais les sources (engine/upstream/ est gitignoré).
#
# Usage : bash engine/scripts/fetch.sh [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../upstream.lock
source "${ENGINE_DIR}/upstream.lock"

CACHE_DIR="${ENGINE_DIR}/.cache"
UPSTREAM_DIR="${ENGINE_DIR}/upstream"

OPENTTD_ARCHIVE="${CACHE_DIR}/openttd-${OPENTTD_VERSION}-source.tar.xz"
OPENTTD_DIR="${UPSTREAM_DIR}/openttd-${OPENTTD_VERSION}"
OPENTTD_STAMP="${OPENTTD_DIR}/.openttd-source.sha256"

OPENGFX_ARCHIVE="${CACHE_DIR}/opengfx-${OPENGFX_VERSION}-all.zip"
OPENGFX_DIR="${UPSTREAM_DIR}/opengfx-${OPENGFX_VERSION}"
OPENGFX_STAMP="${OPENGFX_DIR}/.opengfx.sha256"

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

download() {
  local url="$1" destination="$2" expected="$3" label="$4"
  if [[ -f "${destination}" ]] && [[ "$(sha256_file "${destination}")" == "${expected}" ]]; then
    log "${label} déjà en cache : ${destination}"
    return
  fi
  log "téléchargement de ${url}"
  curl --fail --location --retry 3 --retry-delay 2 --output "${destination}.part" "${url}"
  mv "${destination}.part" "${destination}"
}

verify() {
  local file="$1" expected="$2" label="$3"
  local actual
  actual="$(sha256_file "${file}")"
  if [[ "${actual}" != "${expected}" ]]; then
    rm -f "${file}"
    die "SHA256 invalide pour ${file} (attendu ${expected}, obtenu ${actual})"
  fi
  log "${label} SHA256 OK (${actual})"
}

mkdir -p "${CACHE_DIR}" "${UPSTREAM_DIR}"

# ---------------------------------------------------------------------------
# 1. Sources OpenTTD
if [[ ${FORCE} -eq 0 && -f "${OPENTTD_STAMP}" && -d "${OPENTTD_DIR}" ]]; then
  if [[ "$(cat "${OPENTTD_STAMP}")" == "${OPENTTD_SOURCE_SHA256}" ]]; then
    log "OpenTTD ${OPENTTD_VERSION} déjà extrait et vérifié dans ${OPENTTD_DIR}"
  fi
fi

if [[ ${FORCE} -eq 1 || ! -f "${OPENTTD_STAMP}" || "$(cat "${OPENTTD_STAMP}" 2>/dev/null)" != "${OPENTTD_SOURCE_SHA256}" ]]; then
  download "${OPENTTD_SOURCE_URL}" "${OPENTTD_ARCHIVE}" "${OPENTTD_SOURCE_SHA256}" "archive OpenTTD"
  verify "${OPENTTD_ARCHIVE}" "${OPENTTD_SOURCE_SHA256}" "OpenTTD"

  # Extraction atomique : dossier temporaire puis remplacement.
  tmp_dir="${UPSTREAM_DIR}/.extract-$$"
  rm -rf "${tmp_dir}"
  mkdir -p "${tmp_dir}"
  log "extraction vers ${OPENTTD_DIR}"
  tar -xJf "${OPENTTD_ARCHIVE}" -C "${tmp_dir}"
  extracted="$(find "${tmp_dir}" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  [[ -n "${extracted}" ]] || die "archive OpenTTD inattendue : aucun dossier racine"

  rm -rf "${OPENTTD_DIR}"
  mv "${extracted}" "${OPENTTD_DIR}"
  rm -rf "${tmp_dir}"
  printf '%s\n' "${OPENTTD_SOURCE_SHA256}" > "${OPENTTD_STAMP}"
  log "OpenTTD extrait : ${OPENTTD_DIR}"
fi

# ---------------------------------------------------------------------------
# 2. Base graphique OpenGFX (nécessaire au démarrage headless)
if [[ ${FORCE} -eq 1 || ! -f "${OPENGFX_STAMP}" || "$(cat "${OPENGFX_STAMP}" 2>/dev/null)" != "${OPENGFX_SHA256}" ]]; then
  download "${OPENGFX_URL}" "${OPENGFX_ARCHIVE}" "${OPENGFX_SHA256}" "archive OpenGFX"
  verify "${OPENGFX_ARCHIVE}" "${OPENGFX_SHA256}" "OpenGFX"

  tmp_dir="${UPSTREAM_DIR}/.opengfx-$$"
  rm -rf "${tmp_dir}"
  mkdir -p "${tmp_dir}"
  # L'archive officielle est un zip contenant un unique tar.
  python3 - "${OPENGFX_ARCHIVE}" "${tmp_dir}" <<'PY'
import io
import pathlib
import sys
import tarfile
import zipfile

archive, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
with zipfile.ZipFile(archive) as zf:
    inner = zf.namelist()[0]
    with zf.open(inner) as fh:
        with tarfile.open(fileobj=io.BytesIO(fh.read())) as tf:
            tf.extractall(destination)
PY
  extracted="$(find "${tmp_dir}" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  [[ -n "${extracted}" ]] || die "archive OpenGFX inattendue"

  rm -rf "${OPENGFX_DIR}"
  mv "${extracted}" "${OPENGFX_DIR}"
  rm -rf "${tmp_dir}"
  printf '%s\n' "${OPENGFX_SHA256}" > "${OPENGFX_STAMP}"
  log "OpenGFX extrait : ${OPENGFX_DIR}"
else
  log "OpenGFX ${OPENGFX_VERSION} déjà extrait et vérifié"
fi

log "terminé"
