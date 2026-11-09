// Teste de ponta a ponta do Streamer, sem DAW: conecta num servidor local com um código, manda
// 2 s de um seno de 1 kHz e sai. O script plugin/Tests/e2e.mjs sobe o servidor, gera o código,
// escuta como se fosse o site e confere o que chegou.
//
//   stream_test <servidor> <código> <taxa> <formato 16|24|32>
#include "Streamer.h"

#include <cmath>
#include <cstdio>

int main (int argc, char** argv)
{
    if (argc < 5)
    {
        std::puts ("uso: stream_test <servidor> <código> <taxa> <16|24|32>");
        return 2;
    }
    const double rate = std::atof (argv[3]);
    const int fmt = std::atoi (argv[4]);
    noveau::Streamer net;
    net.prepare (rate, 2);
    net.setFormat (fmt == 16 ? noveau::SampleFormat::int16 : fmt == 32 ? noveau::SampleFormat::float32 : noveau::SampleFormat::int24);
    net.connect (argv[1], argv[2]);

    for (int i = 0; i < 100 && net.status().state != noveau::StreamStatus::State::connected; ++i)
        juce::Thread::sleep (50);
    auto st = net.status();
    std::printf ("estado: %d  %s  nome=%s ouvintes=%d\n", (int) st.state, st.message.toRawUTF8(), st.name.toRawUTF8(), st.listeners);
    if (st.state != noveau::StreamStatus::State::connected)
        return 1;

    // Blocos de 256 como uma DAW, no ritmo do relógio.
    juce::AudioBuffer<float> block (2, 256);
    long long n = 0;
    const auto start = juce::Time::getMillisecondCounterHiRes();
    const long long total = (long long) (rate * 2.0);
    while (n < total)
    {
        for (int i = 0; i < 256; ++i, ++n)
        {
            const float v = 0.5f * (float) std::sin (2.0 * juce::MathConstants<double>::pi * 1000.0 * (double) n / rate);
            block.setSample (0, i, v);
            block.setSample (1, i, -v);
        }
        net.push (block);
        const double due = start + (double) n * 1000.0 / rate;
        const double wait = due - juce::Time::getMillisecondCounterHiRes();
        if (wait > 0)
            juce::Thread::sleep ((int) wait);
    }
    juce::Thread::sleep (300);
    st = net.status();
    std::printf ("fim: kbps=%.0f descartados=%d resume=%s\n", st.kbps, st.dropped, net.getResume().isNotEmpty() ? "sim" : "nao");
    net.disconnect();
    return 0;
}
