#!/usr/bin/env bash
# Construit OpenTTD headless en WebAssembly avec le pont OpenTT3D.
#
# Chaîne :
#   1. sources épinglées        (engine/scripts/fetch.sh)
#   2. toolchain Emscripten     (image Docker upstream ou emsdk natif)
#   3. copie de travail propre  (engine/build/src) + patches engine/patches/
#   4. outils hôte              (strgen, settingsgen) -> engine/build/host
#   5. module WASM              -> engine/build/wasm/opentt3d-engine.{js,wasm,data}
#   6. artefacts web            -> public/engine/
#
# Idempotent : relancer le script reconstruit uniquement ce qui a changé.
# `--clean` supprime engine/build.
#
# Usage :
#   bash engine/scripts/build.sh [--clean] [--baseline] [--docker|--native]
#     --clean      supprime engine/build avant de commencer
#     --baseline   build dédié standard (sans pont), sortie .html
#     --docker     force l'image Docker upstream (emsdk-openttd)
#     --native     force emsdk natif (emcmake/emmake dans le PATH)
#
# Par défaut : image Docker déjà construite, sinon emsdk local, sinon Docker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${ENGINE_DIR}/.." && pwd)"

# shellcheck source=../upstream.lock
source "${ENGINE_DIR}/upstream.lock"

SRC_UPSTREAM="${ENGINE_DIR}/upstream/openttd-${OPENTTD_VERSION}"
OPENGFX_DIR="${ENGINE_DIR}/upstream/opengfx-${OPENGFX_VERSION}"
BUILD_DIR="${ENGINE_DIR}/build"
SRC_DIR="${BUILD_DIR}/src"
HOST_DIR="${BUILD_DIR}/host"
WASM_DIR="${BUILD_DIR}/wasm"
BASELINE_DIR="${BUILD_DIR}/wasm-baseline"
OUT_DIR="${ROOT_DIR}/public/engine"
IMAGE="${OPENTTD_EMSDK_IMAGE}"
PATCH_DIR="${ENGINE_DIR}/patches"
BRIDGE_DIR="${ENGINE_DIR}/bridge"

CLEAN=0
BASELINE=0
MODE="auto"
for arg in "$@"; do
  case "${arg}" in
    --clean) CLEAN=1 ;;
    --baseline) BASELINE=1 ;;
    --docker) MODE="docker" ;;
    --native) MODE="native" ;;
    *) echo "argument inconnu : ${arg}" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m[build]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[build] erreur:\033[0m %s\n' "$*" >&2; exit 1; }

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
DOCKER_COMMON=(docker run --rm -v "${ROOT_DIR}:${ROOT_DIR}" -u "${HOST_UID}:${HOST_GID}" -e HOME=/tmp -e EM_CACHE=/tmp/emscripten-cache)

# --- Sélection du toolchain -------------------------------------------------
if [[ "${MODE}" == "auto" ]]; then
  # Priorité à une image déjà construite, puis à un emsdk local, puis à Docker.
  if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    MODE="docker"
  elif command -v emcmake >/dev/null 2>&1 || [[ -f "${ENGINE_DIR}/.cache/emsdk/emsdk_env.sh" ]]; then
    MODE="native"
  elif docker info >/dev/null 2>&1; then
    MODE="docker"
  else
    die "ni Docker ni emsdk natif disponibles (voir --native / --docker)"
  fi
fi

if [[ "${MODE}" == "docker" ]]; then
  docker info >/dev/null 2>&1 || die "Docker n'est pas disponible (lancez Docker Desktop)"
else
  # emsdk local installé par engine/.cache/emsdk (gitignoré) ?
  if ! command -v emcmake >/dev/null 2>&1 && [[ -f "${ENGINE_DIR}/.cache/emsdk/emsdk_env.sh" ]]; then
    log "activation de l'emsdk local : engine/.cache/emsdk"
    set +u
    # shellcheck disable=SC1091
    source "${ENGINE_DIR}/.cache/emsdk/emsdk_env.sh" >/dev/null 2>&1
    set -u
  fi
  command -v emcmake >/dev/null 2>&1 || die "emcmake introuvable (sourcez emsdk_env.sh ou utilisez --docker)"
fi

if ! command -v cmake >/dev/null 2>&1; then
  for candidate in \
    "${ENGINE_DIR}/.cache/cmake-venv/bin/cmake" \
    /opt/homebrew/bin/cmake \
    /usr/local/bin/cmake; do
    if [[ -x "${candidate}" ]]; then
      PATH="$(dirname "${candidate}"):${PATH}"
      break
    fi
  done
fi
CMAKE_BIN="${CMAKE_BIN:-cmake}"
command -v "${CMAKE_BIN}" >/dev/null 2>&1 || die "cmake introuvable (brew install cmake ou pip install cmake)"

run_tool() {
  local workdir="$1"; shift
  if [[ "${MODE}" == "docker" ]]; then
    "${DOCKER_COMMON[@]}" --workdir "${workdir}" "${IMAGE}" "$@"
  else
    (cd "${workdir}" && "$@")
  fi
}

# ---------------------------------------------------------------------------
step "0/6 Vérification du toolchain (${MODE})"
if [[ "${MODE}" == "docker" ]]; then
  log "Docker OK, image cible : ${IMAGE}"
else
  log "emsdk natif : $(command -v emcc)"
  emcc --version | head -1
  # Le port liblzma est fourni par OpenTTD (voir os/emscripten/Dockerfile).
  EMSDK_ROOT="${EMSDK:-$(cd "$(dirname "$(command -v emcc)")/../.." && pwd)}"
  PORT_DST="${EMSDK_ROOT}/upstream/emscripten/tools/ports/contrib"
  if [[ -d "${PORT_DST}" ]]; then
    cp "${SRC_UPSTREAM}/os/emscripten/ports/liblzma.py" "${PORT_DST}/"
    log "port liblzma installé dans ${PORT_DST}"
  fi

  # Le Python embarqué par emsdk sur macOS arm64 est parfois compilé sans
  # module _lzma, ce qui casse l'extraction des ports (.tar.xz). On bascule
  # alors sur le Python système, qui fournit lzma.
  EMSDK_PY="$(find "${EMSDK_ROOT}/python" -path '*/bin/python3' -type f 2>/dev/null | head -n 1)"
  if [[ -n "${EMSDK_PY}" && -x "${EMSDK_PY}" ]] && ! "${EMSDK_PY}" -c 'import lzma' >/dev/null 2>&1; then
    export EMSDK_PYTHON="${EMSDK_PYTHON:-$(command -v python3)}"
    log "Python emsdk sans lzma : EMSDK_PYTHON=${EMSDK_PYTHON}"
  fi
fi

# ---------------------------------------------------------------------------
step "1/6 Sources OpenTTD ${OPENTTD_VERSION}"
bash "${SCRIPT_DIR}/fetch.sh"

# ---------------------------------------------------------------------------
step "2/6 Toolchain Emscripten"
if [[ "${MODE}" == "docker" ]]; then
  if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
    log "image déjà présente : ${IMAGE}"
  else
    log "construction de ${IMAGE} depuis os/emscripten/Dockerfile (peut prendre plusieurs minutes)"
    docker build -t "${IMAGE}" "${SRC_UPSTREAM}/os/emscripten"
  fi
else
  log "emsdk natif déjà actif"
fi

# ---------------------------------------------------------------------------
step "3/6 Copie de travail et patches"
if [[ ${CLEAN} -eq 1 ]]; then
  log "suppression de ${BUILD_DIR}"
  rm -rf "${BUILD_DIR}"
fi
mkdir -p "${BUILD_DIR}" "${HOST_DIR}" "${WASM_DIR}" "${OUT_DIR}"

# Copie fraîche des sources : garantit que les patches s'appliquent toujours
# sur la version épinglée, même après un build interrompu.
rm -rf "${SRC_DIR}"
cp -Rp "${SRC_UPSTREAM}" "${SRC_DIR}"
log "sources copiées dans ${SRC_DIR}"

shopt -s nullglob
patches=("${PATCH_DIR}"/*.patch)
shopt -u nullglob
[[ ${#patches[@]} -gt 0 ]] || die "aucun patch dans ${PATCH_DIR}"
for patch_file in "${patches[@]}"; do
  log "application de $(basename "${patch_file}")"
  (cd "${SRC_DIR}" && patch -p1 --batch --forward < "${patch_file}") || die "échec du patch ${patch_file}"
done

# Les patches référencent ${CMAKE_SOURCE_DIR}/../../bridge : c'est bien
# engine/bridge lorsque CMAKE_SOURCE_DIR vaut engine/build/src.
[[ -f "${BRIDGE_DIR}/ottd_bridge.cpp" ]] || die "pont introuvable : ${BRIDGE_DIR}/ottd_bridge.cpp"

# ---------------------------------------------------------------------------
step "4/6 Outils hôte (strgen, settingsgen)"
log "CMake hôte"
run_tool "${HOST_DIR}" "${CMAKE_BIN}" "${SRC_DIR}" \
  -DOPTION_TOOLS_ONLY=ON \
  -DCMAKE_BUILD_TYPE=Release
log "make -j${JOBS} tools"
run_tool "${HOST_DIR}" make -j"${JOBS}" tools
[[ -x "${HOST_DIR}/src/strgen/strgen" ]] || die "strgen non généré"
[[ -x "${HOST_DIR}/src/settingsgen/settingsgen" ]] || die "settingsgen non généré"
log "outils hôte OK"

# ---------------------------------------------------------------------------
step "5/6 Module WebAssembly"
CMAKE_ARGS=(
  "${SRC_DIR}"
  "-DHOST_BINARY_DIR=${HOST_DIR}"
  -DCMAKE_BUILD_TYPE=Release
  -DOPTION_USE_ASSERTS=OFF
  -DOPTION_DEDICATED=ON
)
if [[ ${BASELINE} -eq 1 ]]; then
  log "mode baseline : pont désactivé (sortie HTML)"
  CMAKE_ARGS+=(-DOPTION_OTT3D_BRIDGE=OFF)
  WASM_DIR="${BASELINE_DIR}"
  mkdir -p "${WASM_DIR}"
else
  CMAKE_ARGS+=(-DOPTION_OTT3D_BRIDGE=ON)
fi

log "emcmake cmake ${CMAKE_ARGS[*]}"
run_tool "${WASM_DIR}" emcmake cmake "${CMAKE_ARGS[@]}"

# OpenGFX est copié dans le dossier preloadé par le module. Sans lui,
# OpenTTD tenterait d'ouvrir l'écran de téléchargement (impossible headless).
if [[ ${BASELINE} -eq 0 ]]; then
  [[ -d "${OPENGFX_DIR}" ]] || die "OpenGFX introuvable : ${OPENGFX_DIR} (relancez fetch.sh)"
  mkdir -p "${WASM_DIR}/baseset"
  cp "${OPENGFX_DIR}"/*.grf "${OPENGFX_DIR}"/opengfx.obg "${WASM_DIR}/baseset/"
  log "OpenGFX ${OPENGFX_VERSION} copié dans ${WASM_DIR}/baseset"
  # IA minimale du dépôt (engine/ai) : le patch CMake la précharge dans /ai.
  [[ -d "${ENGINE_DIR}/ai" ]] || die "scripts IA introuvables : ${ENGINE_DIR}/ai"
  log "IA OpenTT3D : ${ENGINE_DIR}/ai (préchargée dans /ai)"
  # Le packager Emscripten ne suit pas les fichiers ajoutés après coup :
  # on force la réédition du module pour intégrer le nouveau baseset et l'IA.
  rm -f "${WASM_DIR}/opentt3d-engine.js" "${WASM_DIR}/opentt3d-engine.wasm" "${WASM_DIR}/opentt3d-engine.data"
fi

log "emmake make -j${JOBS} openttd"
run_tool "${WASM_DIR}" emmake make -j"${JOBS}" openttd

if [[ ${BASELINE} -eq 1 ]]; then
  ls -lh "${WASM_DIR}"/openttd.html "${WASM_DIR}"/openttd.js "${WASM_DIR}"/openttd.wasm 2>/dev/null || true
  log "baseline terminée : ${WASM_DIR}/openttd.html"
  exit 0
fi

[[ -f "${WASM_DIR}/opentt3d-engine.js" ]] || die "opentt3d-engine.js manquant"
[[ -f "${WASM_DIR}/opentt3d-engine.wasm" ]] || die "opentt3d-engine.wasm manquant"
[[ -f "${WASM_DIR}/opentt3d-engine.data" ]] || die "opentt3d-engine.data manquant (baseset préchargé)"

# ---------------------------------------------------------------------------
step "6/6 Publication des artefacts"
cp "${WASM_DIR}/opentt3d-engine.js"   "${OUT_DIR}/opentt3d-engine.js"
cp "${WASM_DIR}/opentt3d-engine.wasm" "${OUT_DIR}/opentt3d-engine.wasm"
cp "${WASM_DIR}/opentt3d-engine.data" "${OUT_DIR}/opentt3d-engine.data"
ls -lh "${OUT_DIR}/opentt3d-engine."{js,wasm,data}

log "build terminé"
log "test : node engine/scripts/smoke.mjs"
