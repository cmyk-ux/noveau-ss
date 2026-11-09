#pragma once
// Leva o som do plugin até o servidor do noveau.
//
// A thread de áudio da DAW só copia amostras para uma fila sem trava (nunca espera rede).
// Uma thread própria tira blocos de 10 ms da fila, monta os pacotes (Packet.h) e manda por
// WebSocket (wss://SERVIDOR/api/daw/send). Se a internet não der conta, descarta pacotes em vez
// de acumular atraso: quem ouve completa a lacuna com silêncio.

#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>

#include "Packet.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ix { class WebSocket; }

namespace noveau
{
struct StreamStatus
{
    enum class State { idle, connecting, connected, failed };
    State state = State::idle;
    juce::String message;   // texto para mostrar na tela
    juce::String name;      // nome de quem pareou no site
    int listeners = 0;
    double kbps = 0;        // taxa enviada agora
    int dropped = 0;        // pacotes descartados por rede lenta (desde que conectou)
};

class Streamer : private juce::Thread
{
public:
    Streamer();
    ~Streamer() override;

    /** Chamado no prepareToPlay. */
    void prepare (double sampleRate, int channels);

    /** Thread de áudio: copia o bloco para a fila. Não aloca e não trava. */
    void push (const juce::AudioBuffer<float>& buffer);

    /** Conecta com um código novo (do site) ou com a chave de volta guardada. */
    void connect (const juce::String& server, const juce::String& code);
    void disconnect();

    void setFormat (SampleFormat f) { format.store ((int) f); }
    SampleFormat getFormat() const { return (SampleFormat) format.load(); }

    /** Chave de volta (guardada no projeto da DAW para reconectar sozinho). */
    juce::String getResume() const;
    void setResume (const juce::String& r);
    juce::String getServer() const;

    StreamStatus status() const;

    /** wss://host/api/daw/send a partir do que a pessoa digitou ("noveau.riajuu.net", "https://...", "http://localhost:4200"). */
    static juce::String socketUrl (const juce::String& server);

private:
    void run() override;
    void onText (const std::string& text);
    void setStatus (StreamStatus::State s, const juce::String& msg);

    // Fila: amostras intercaladas, até 2 s na maior taxa.
    static constexpr int kFifoFrames = 192000 * 2;
    juce::AbstractFifo fifo { kFifoFrames };
    std::vector<float> ring;
    std::atomic<int> channels { 2 };
    std::atomic<double> rate { 48000.0 };
    std::atomic<int> format { (int) SampleFormat::int24 };
    std::atomic<bool> live { false };    // conectado e autorizado: vale a pena encher a fila
    std::atomic<int> overflow { 0 };

    std::unique_ptr<ix::WebSocket> ws;
    std::mutex wsLock;                   // protege ws (thread de rede x botões da tela)
    mutable std::mutex lock;             // protege status, resume, server, code
    StreamStatus st;
    juce::String resume, server, pendingCode;
    std::uint32_t seq = 0;
    std::atomic<double> kbps { 0 };
    std::atomic<int> dropped { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Streamer)
};
} // namespace noveau
