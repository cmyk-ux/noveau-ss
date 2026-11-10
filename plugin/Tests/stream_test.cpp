// Teste de ponta a ponta do Streamer, sem DAW: conecta num servidor local, manda um seno de 1 kHz
// e sai. O script plugin/Tests/e2e.mjs sobe o servidor, escuta como se fosse o site e confere.
//
//   stream_test <servidor> <como> <taxa> <formato 16|24|32> [segundos]
//   como: code:ABCD-EFGH | link | key:discord:<chave> | key:room:<chave>
// Escreve "LINK <código>" quando espera confirmar no site e "KEY <modo> <chave>" quando recebe chave.
#include "Streamer.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

int main (int argc, char** argv)
{
    if (argc < 5)
    {
        std::puts ("uso: stream_test <servidor> <code:XXXX|link|key:discord:K|key:room:K> <taxa> <16|24|32> [segundos]");
        return 2;
    }
    const juce::String server (argv[1]), how (argv[2]);
    const double rate = std::atof (argv[3]);
    const int fmt = std::atoi (argv[4]);
    const double seconds = argc > 5 ? std::atof (argv[5]) : 2.0;
    using S = noveau::StreamStatus::State;

    noveau::Streamer net;
    net.prepare (rate, 2);
    net.setFormat (fmt == 16 ? noveau::SampleFormat::int16 : fmt == 32 ? noveau::SampleFormat::float32 : noveau::SampleFormat::int24);
    net.onKey = [] (noveau::Mode mode, const juce::String& key, const juce::String&) {
        std::printf ("KEY %s %s\n", mode == noveau::Mode::discord ? "discord" : "room", key.isEmpty() ? "-" : key.toRawUTF8());
        std::fflush (stdout);
    };
    if (how == "link")
        net.connectLink (server);
    else if (how.startsWith ("code:"))
        net.connectCode (server, how.fromFirstOccurrenceOf ("code:", false, false));
    else if (how.startsWith ("key:"))
    {
        const auto rest = how.fromFirstOccurrenceOf ("key:", false, false);
        net.connectKey (server, rest.startsWith ("room:") ? noveau::Mode::room : noveau::Mode::discord, rest.fromFirstOccurrenceOf (":", false, false));
    }

    juce::String shown;
    for (int i = 0; i < 1200 && net.status().state != S::connected; ++i)
    {
        const auto st = net.status();
        if (st.state == S::failed)
            break;
        if (st.linkCode.isNotEmpty() && st.linkCode != shown)
        {
            shown = st.linkCode;
            std::printf ("LINK %s\n", shown.toRawUTF8());
            std::fflush (stdout);
        }
        juce::Thread::sleep (50);
    }
    auto st = net.status();
    std::printf ("estado: %d  %s  nome=%s\n", (int) st.state, st.message.toRawUTF8(), st.name.toRawUTF8());
    if (st.state != S::connected)
        return 1;
    // Espera alguém ouvindo (sem ouvinte o plugin não manda nada).
    for (int i = 0; i < 60 && net.status().listeners == 0; ++i)
        juce::Thread::sleep (50);

    // Blocos de 256 como uma DAW, no ritmo do relógio.
    juce::AudioBuffer<float> block (2, 256);
    long long n = 0;
    const auto start = juce::Time::getMillisecondCounterHiRes();
    const auto total = (long long) (rate * seconds);
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
    std::printf ("fim: kbps=%.0f descartados=%d call=%s ouvintes=%d\n", st.kbps, st.dropped, st.call.isEmpty() ? "-" : st.call.toRawUTF8(), st.listeners);
    std::fflush (stdout);
    net.onKey = nullptr;
    net.disconnect();
    return 0;
}
