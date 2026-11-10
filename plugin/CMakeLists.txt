# Plugin de DAW do Noveau: VST3 + AU (macOS) + app avulso.
# Manda a saída da DAW para uma sala do site, sem compressão (veja server/daw.mjs).
#
#   cmake -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build --config Release
#
# No GitHub, .github/workflows/plugin.yml compila para Windows e macOS sozinho.

cmake_minimum_required(VERSION 3.22)
project(NoveauDAW VERSION 0.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(APPLE)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")
endif()
if(MSVC)
  # Runtime estático: o plugin não depende do "Visual C++ Redistributable" instalado.
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

FetchContent_Declare(juce
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 9.0.5
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(juce)

# WebSocket (wss://) para falar com o servidor. Compilado direto, sem o CMake dele.
FetchContent_Declare(ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
  GIT_TAG v11.4.6
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR nao-usar-o-cmake-deles)
FetchContent_MakeAvailable(ixwebsocket)

file(GLOB IX_SOURCES ${ixwebsocket_SOURCE_DIR}/ixwebsocket/*.cpp)
list(FILTER IX_SOURCES EXCLUDE REGEX "IXBench\\.cpp$")
add_library(ixws STATIC ${IX_SOURCES})
target_include_directories(ixws PUBLIC ${ixwebsocket_SOURCE_DIR})
target_compile_definitions(ixws PUBLIC IXWEBSOCKET_USE_TLS)

if(WIN32)
  # Windows: mbedTLS, com os certificados do próprio Windows (caFile "SYSTEM").
  FetchContent_Declare(mbedtls
    URL https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2)
  set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
  set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
  set(MBEDTLS_FATAL_WARNINGS OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(mbedtls)
  target_compile_definitions(ixws PUBLIC IXWEBSOCKET_USE_MBED_TLS IXWEBSOCKET_USE_MBED_TLS_MIN_VERSION_3)
  target_link_libraries(ixws PUBLIC mbedtls mbedx509 mbedcrypto ws2_32 crypt32 shlwapi)
elseif(APPLE)
  # macOS: TLS do sistema (Secure Transport), confia nos mesmos certificados que o Safari.
  target_compile_definitions(ixws PUBLIC IXWEBSOCKET_USE_SECURE_TRANSPORT)
  target_link_libraries(ixws PUBLIC "-framework Security" "-framework Foundation")
else()
  find_package(OpenSSL REQUIRED)
  find_package(Threads REQUIRED)
  target_compile_definitions(ixws PUBLIC IXWEBSOCKET_USE_OPEN_SSL)
  target_link_libraries(ixws PUBLIC OpenSSL::SSL OpenSSL::Crypto Threads::Threads)
endif()

set(FORMATS VST3 Standalone)
if(APPLE)
  list(APPEND FORMATS AU)
endif()
# AAX (Pro Tools): o SDK vem dentro da JUCE (licença GPLv3 ou comercial da Avid). Sem a assinatura
# PACE/iLok ele só abre no "Pro Tools Developer"; veja docs/PLUGIN-DAW.md.
if(WIN32 OR APPLE)
  list(APPEND FORMATS AAX)
endif()

juce_add_plugin(NoveauDAW
  COMPANY_NAME "noveau"
  COMPANY_WEBSITE "https://noveau.riajuu.net"
  BUNDLE_ID "net.riajuu.noveau.daw"
  PLUGIN_MANUFACTURER_CODE Nvau
  PLUGIN_CODE Ndaw
  PRODUCT_NAME "noveau DAW"
  DESCRIPTION "Manda a saída da DAW para uma sala do noveau, sem compressão"
  FORMATS ${FORMATS}
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  NEEDS_MIDI_OUTPUT FALSE
  IS_MIDI_EFFECT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS TRUE
  COPY_PLUGIN_AFTER_BUILD FALSE
  VST3_CATEGORIES Fx Tools Network
  AAX_CATEGORY AAX_ePlugInCategory_Effect
  AU_MAIN_TYPE kAudioUnitType_Effect)

target_sources(NoveauDAW PRIVATE
  Source/PluginProcessor.cpp
  Source/PluginEditor.cpp
  Source/Streamer.cpp
  Source/Packet.cpp)

target_compile_definitions(NoveauDAW PUBLIC
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_VST3_CAN_REPLACE_VST2=0
  JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_REPORT_APP_USAGE=0)

target_link_libraries(NoveauDAW
  PRIVATE
    juce::juce_audio_utils
    ixws
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)

# Teste do formato dos pacotes (roda no CI, sem DAW).
add_executable(packet_test Source/Packet.cpp Tests/packet_test.cpp)
target_include_directories(packet_test PRIVATE Source)

# Teste de ponta a ponta do envio (só com -DNOVEAU_TESTS=ON; veja Tests/e2e.mjs).
option(NOVEAU_TESTS "Compila o teste de envio" OFF)
if(NOVEAU_TESTS)
  juce_add_console_app(stream_test PRODUCT_NAME "stream_test")
  target_sources(stream_test PRIVATE Tests/stream_test.cpp Source/Streamer.cpp Source/Packet.cpp)
  target_include_directories(stream_test PRIVATE Source)
  target_compile_definitions(stream_test PRIVATE JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JucePlugin_VersionString="teste")
  target_link_libraries(stream_test PRIVATE juce::juce_events juce::juce_audio_basics ixws)
endif()
