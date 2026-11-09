#pragma once
// Formato do pacote de áudio do plugin (o mesmo que server/daw.mjs e web/src/app/core/studio.ts leem).
//
// Cabeçalho de 16 bytes, little-endian, depois as amostras intercaladas (L R L R ...):
//   0 'S' | 1 versão 2 | 2 formato (16 = int16, 24 = int24, 32 = float32) | 3 canais (1 ou 2)
//   4..7 número de sequência | 8..9 frames | 10..11 livre | 12..15 taxa de amostragem (Hz)

#include <cstddef>
#include <cstdint>
#include <string>

namespace noveau
{
constexpr std::size_t kHeaderBytes = 16;

enum class SampleFormat : std::uint8_t
{
    int16 = 16,
    int24 = 24,
    float32 = 32,
};

/** Taxas que o servidor aceita. */
bool isSupportedRate (std::uint32_t rate);

/** Bytes do pacote para `frames` quadros. */
std::size_t packetBytes (SampleFormat format, int channels, int frames);

/**
 * Monta o pacote em `out` (que é redimensionado). `interleaved` tem frames * channels floats.
 * Inteiros: arredonda com a escala 2^(bits-1), igual ao navegador, e corta o que passar de ±1.
 * Float32: copia os bits exatamente como a DAW entregou.
 */
void encodePacket (std::string& out,
                   SampleFormat format,
                   int channels,
                   std::uint32_t sampleRate,
                   std::uint32_t sequence,
                   const float* interleaved,
                   int frames);
} // namespace noveau
