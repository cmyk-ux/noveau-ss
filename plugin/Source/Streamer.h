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
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ix { class WebSocket; }

namespace noveau
{
/** Como o plugin entra: pela conta do Discord (segue a call) ou com o código de uma sala. */
enum class Mode { discord, room };

struct StreamStatus
{
    enum class State { idle, linking, connecting, connected, failed };
    State state = State::idle;
    Mode mode = Mode::discord;
    juce::String message;   // texto para mostrar na tela
    juce::String name;      // nome de quem ligou (no Discord ou no site)
    juce::String linkCode;  // esperando confirmar no navegador: o código que aparece lá
    juce::String call;      // modo Discord: nome da call em que a pessoa está ("" = fora de call)
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

    /** Pede para ligar à conta do Discord: o servidor manda um código e a pessoa confirma em siteUrl(.., "/plugin?c=..."). */
    void connectLink (const juce::String& server);
    /** Volta com a chave guardada (do Discord ou de uma sala). */
    void connectKey (const juce::String& server, Mode mode, const juce::String& key);
    /** Entra com o código de sala gerado no site. */
    void connectCode (const juce::String& server, const juce::String& code);
    void disconnect();

    /**
     * Chamado (da thread de rede) quando o servidor manda uma chave nova para guardar, ou quando a
     * chave guardada deixou de valer (key vazio). Defina antes de conectar.
     */
    std::function<void (Mode mode, const juce::String& key, const juce::String& name)> onKey;

    void setFormat (SampleFormat f) { format.store ((int) f); }
    SampleFormat getFormat() const { return (SampleFormat) format.load(); }

    juce::String getServer() const;

    StreamStatus status() const;

    /** wss://host/api/daw/send a partir do que a pessoa digitou ("noveau.riajuu.net", "https://...", "http://localhost:4200"). */
    static juce::String socketUrl (const juce::String& server);
    /** https://host/caminho do site, a partir do que a pessoa digitou. */
    static juce::String siteUrl (const juce::String& server, const juce::String& path);

private:
    enum class Hello { link, key, code };
    void open (const juce::String& server, Hello how, Mode mode, const juce::String& secret);
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
    std::atomic<int> audience { 0 };     // ninguém ouvindo: não gasta internet

    std::unique_ptr<ix::WebSocket> ws;
    std::mutex wsLock;                   // protege ws (thread de rede x botões da tela)
    mutable std::mutex lock;             // protege status, server, hello
    StreamStatus st;
    juce::String server, secret;         // secret: código ou chave que vai no hello
    Hello hello = Hello::link;
    const juce::String instance;         // identifica esta cópia do plugin para o servidor
    std::uint32_t seq = 0;
    std::atomic<double> kbps { 0 };
    std::atomic<int> dropped { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Streamer)
};
} // namespace noveau
