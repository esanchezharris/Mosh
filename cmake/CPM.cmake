# CPM.cmake bootstrap — downloads and caches a pinned CPM release.
# Pinned to v0.42.3 (resolved via `git ls-remote` 2026-06-08).
# Standard download-on-configure pattern (https://github.com/cpm-cmake/CPM.cmake).

set(CPM_DOWNLOAD_VERSION 0.42.3)
set(CPM_HASH_SUM "") # optional integrity hash; left empty for private research use

if(CPM_SOURCE_CACHE)
  set(CPM_DOWNLOAD_LOCATION "${CPM_SOURCE_CACHE}/cpm/CPM_${CPM_DOWNLOAD_VERSION}.cmake")
elseif(DEFINED ENV{CPM_SOURCE_CACHE})
  set(CPM_DOWNLOAD_LOCATION "$ENV{CPM_SOURCE_CACHE}/cpm/CPM_${CPM_DOWNLOAD_VERSION}.cmake")
else()
  set(CPM_DOWNLOAD_LOCATION "${CMAKE_BINARY_DIR}/cmake/CPM_${CPM_DOWNLOAD_VERSION}.cmake")
endif()

get_filename_component(CPM_DOWNLOAD_LOCATION ${CPM_DOWNLOAD_LOCATION} ABSOLUTE)

function(_mosh_download_cpm)
  if(NOT (EXISTS ${CPM_DOWNLOAD_LOCATION}))
    message(STATUS "Mosh: downloading CPM.cmake v${CPM_DOWNLOAD_VERSION}")
    file(DOWNLOAD
      https://github.com/cpm-cmake/CPM.cmake/releases/download/v${CPM_DOWNLOAD_VERSION}/CPM.cmake
      ${CPM_DOWNLOAD_LOCATION})
  endif()
endfunction()

_mosh_download_cpm()
include(${CPM_DOWNLOAD_LOCATION})
