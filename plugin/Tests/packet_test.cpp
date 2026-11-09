// Confere o formato do pacote e grava exemplos em arquivos para o teste do lado do site/servidor
// (plugin/Tests/check-packets.mjs) decodificar e comparar.
#undef NDEBUG // os asserts valem também no build Release
#include "Packet.h"

#include <cassert>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

using namespace noveau;

int main (int argc, char** argv)
{
    const char* dir = argc > 1 ? argv[1] : ".";
    const float samples[] = { 0.0f, 1.0f, -1.0f, 0.5f, -0.25f, 1.5f, -2.0f, 0.123456789f, 3.0e-6f, -0.999999f };
    const int frames = 5;

    std::string pkt;
    encodePacket (pkt, SampleFormat::int24, 2, 96000, 7, samples, frames);
    assert (pkt.size() == 16 + 5 * 2 * 3);
    auto* p = reinterpret_cast<const unsigned char*> (pkt.data());
    assert (p[0] == 'S' && p[1] == 2 && p[2] == 24 && p[3] == 2);
    assert (p[4] == 7 && p[8] == 5 && p[12] == 0x00 && p[13] == 0x77 && p[14] == 0x01); // 96000 = 0x017700
    // 1.0 corta em 0x7fffff; -1.0 = -0x800000
    assert (p[16 + 3] == 0xff && p[16 + 4] == 0xff && p[16 + 5] == 0x7f);
    assert (p[16 + 6] == 0x00 && p[16 + 7] == 0x00 && p[16 + 8] == 0x80);

    for (auto [fmt, name] : { std::pair { SampleFormat::int16, "16" }, { SampleFormat::int24, "24" }, { SampleFormat::float32, "32" } })
    {
        encodePacket (pkt, fmt, 2, 44100, 123456, samples, frames);
        std::ofstream f (std::string (dir) + "/packet-" + name + ".bin", std::ios::binary);
        f.write (pkt.data(), (std::streamsize) pkt.size());
    }
    encodePacket (pkt, SampleFormat::float32, 1, 48000, 1, samples, 10);
    std::ofstream (std::string (dir) + "/packet-mono.bin", std::ios::binary).write (pkt.data(), (std::streamsize) pkt.size());

    assert (isSupportedRate (44100) && isSupportedRate (192000) && ! isSupportedRate (22050));
    std::puts ("packet_test ok");
    return 0;
}
