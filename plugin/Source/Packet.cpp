#include "Packet.h"

#include <cmath>
#include <cstring>

namespace noveau
{
bool isSupportedRate (std::uint32_t rate)
{
    switch (rate)
    {
        case 44100: case 48000: case 88200: case 96000: case 176400: case 192000:
            return true;
        default:
            return false;
    }
}

std::size_t packetBytes (SampleFormat format, int channels, int frames)
{
    return kHeaderBytes + (std::size_t) frames * (std::size_t) channels * ((std::size_t) format / 8);
}

static void put16 (unsigned char* p, std::uint16_t v) { p[0] = (unsigned char) (v & 0xff); p[1] = (unsigned char) (v >> 8); }
static void put32 (unsigned char* p, std::uint32_t v)
{
    for (int i = 0; i < 4; ++i)
        p[i] = (unsigned char) ((v >> (8 * i)) & 0xff);
}

static std::int32_t quantize (float x, double scale, std::int32_t lo, std::int32_t hi)
{
    if (std::isnan (x))
        return 0;
    const auto v = (std::int64_t) std::llround ((double) x * scale);
    return (std::int32_t) (v < lo ? lo : v > hi ? hi : v);
}

void encodePacket (std::string& out, SampleFormat format, int channels, std::uint32_t sampleRate,
                   std::uint32_t sequence, const float* interleaved, int frames)
{
    out.resize (packetBytes (format, channels, frames));
    auto* p = reinterpret_cast<unsigned char*> (out.data());
    p[0] = 'S';
    p[1] = 2;
    p[2] = (unsigned char) format;
    p[3] = (unsigned char) channels;
    put32 (p + 4, sequence);
    put16 (p + 8, (std::uint16_t) frames);
    put16 (p + 10, 0);
    put32 (p + 12, sampleRate);

    auto* o = p + kHeaderBytes;
    const int n = frames * channels;
    switch (format)
    {
        case SampleFormat::int16:
            for (int i = 0; i < n; ++i, o += 2)
                put16 (o, (std::uint16_t) (std::int16_t) quantize (interleaved[i], 32768.0, -32768, 32767));
            break;
        case SampleFormat::int24:
            for (int i = 0; i < n; ++i, o += 3)
            {
                const auto v = (std::uint32_t) quantize (interleaved[i], 8388608.0, -8388608, 8388607);
                o[0] = (unsigned char) (v & 0xff);
                o[1] = (unsigned char) ((v >> 8) & 0xff);
                o[2] = (unsigned char) ((v >> 16) & 0xff);
            }
            break;
        case SampleFormat::float32:
            for (int i = 0; i < n; ++i, o += 4)
            {
                std::uint32_t bits;
                std::memcpy (&bits, interleaved + i, 4);
                put32 (o, bits);
            }
            break;
    }
}
} // namespace noveau
