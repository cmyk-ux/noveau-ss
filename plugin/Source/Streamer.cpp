#include "Streamer.h"

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

namespace noveau
{
namespace
{
    /** Quanto som pode esperar na fila de saída do WebSocket antes de começar a descartar. */
    constexpr double kMaxBacklogSeconds = 0.5;

    std::once_flag netInit;
} // namespace

Streamer::Streamer() : juce::Thread ("noveau-rede")
{
    std::call_once (netInit, [] { ix::initNetSystem(); });
    ring.assign ((size_t) kFifoFrames * 2, 0.0f);
    startThread (juce::Thread::Priority::high);
}

Streamer::~Streamer()
{
    disconnect();
    stopThread (2000);
}

void Streamer::prepare (double sampleRate, int numChannels)
{
    rate.store (sampleRate);
    channels.store (juce::jlimit (1, 2, numChannels));
}

void Streamer::push (const juce::AudioBuffer<float>& buffer)
{
    if (! live.load (std::memory_order_relaxed))
        return;
    const int n = buffer.getNumSamples();
    const int ch = juce::jmin (2, buffer.getNumChannels());
    if (n == 0 || ch == 0)
        return;
    if (fifo.getFreeSpace() < n)
    {
        overflow.fetch_add (1, std::memory_order_relaxed);
        return;
    }
    const float* l = buffer.getReadPointer (0);
    const float* r = buffer.getReadPointer (ch > 1 ? 1 : 0);
    const auto scope = fifo.write (n);
    auto copy = [&] (int start, int size, int offset) {
        for (int i = 0; i < size; ++i)
        {
            ring[(size_t) (start + i) * 2] = l[offset + i];
            ring[(size_t) (start + i) * 2 + 1] = r[offset + i];
        }
    };
    copy (scope.startIndex1, scope.blockSize1, 0);
    copy (scope.startIndex2, scope.blockSize2, scope.blockSize1);
}

juce::String Streamer::socketUrl (const juce::String& typed)
{
    auto s = typed.trim();
    if (s.isEmpty())
        s = "noveau.riajuu.net";
    bool secure = true;
    if (s.startsWithIgnoreCase ("http://") || s.startsWithIgnoreCase ("ws://"))
        secure = false;
    s = s.fromFirstOccurrenceOf ("://", false, false).isNotEmpty() ? s.fromFirstOccurrenceOf ("://", false, false) : s;
    const auto host = s.upToFirstOccurrenceOf ("/", false, false);
    // Endereços locais sem "https://" na frente: teste no próprio PC.
    if (! typed.contains ("://") && (host.startsWith ("localhost") || host.startsWith ("127.")))
        secure = false;
    return juce::String (secure ? "wss://" : "ws://") + host + "/api/daw/send";
}

void Streamer::connect (const juce::String& serverText, const juce::String& code)
{
    disconnect();
    {
        std::lock_guard<std::mutex> g (lock);
        server = serverText.trim();
        pendingCode = code.trim();
        if (pendingCode.isEmpty() && resume.isEmpty())
        {
            st = {};
            st.state = StreamStatus::State::failed;
            st.message = juce::String::fromUTF8 ("Gere um código no site (tecla do plugin, na barra de baixo) e digite aqui.");
            return;
        }
    }

    auto socket = std::make_unique<ix::WebSocket>();
    auto* raw = socket.get();
    socket->setUrl (socketUrl (serverText).toStdString());
    socket->disablePerMessageDeflate(); // PCM não comprime bem e custaria CPU
    socket->setPingInterval (20);
    socket->setMinWaitBetweenReconnectionRetries (1000);
    socket->setMaxWaitBetweenReconnectionRetries (10000);
    socket->setOnMessageCallback ([this, raw] (const ix::WebSocketMessagePtr& msg) {
        switch (msg->type)
        {
            case ix::WebSocketMessageType::Open:
            {
                auto hello = std::make_unique<juce::DynamicObject>();
                hello->setProperty ("t", "hello");
                hello->setProperty ("plugin", JucePlugin_VersionString);
                {
                    std::lock_guard<std::mutex> g (lock);
                    if (pendingCode.isNotEmpty())
                        hello->setProperty ("code", pendingCode);
                    else
                        hello->setProperty ("resume", resume);
                }
                raw->sendText (juce::JSON::toString (juce::var (hello.release()), true).toStdString());
                setStatus (StreamStatus::State::connecting, juce::String::fromUTF8 ("Conectado ao servidor, conferindo…"));
                break;
            }
            case ix::WebSocketMessageType::Message:
                if (! msg->binary)
                    onText (msg->str);
                break;
            case ix::WebSocketMessageType::Close:
                live.store (false);
                if (msg->closeInfo.code == 4000)
                {
                    raw->disableAutomaticReconnection();
                    setStatus (StreamStatus::State::failed, juce::String::fromUTF8 ("Outra cópia do plugin assumiu esta conexão."));
                }
                else if (msg->closeInfo.code == 4003)
                {
                    raw->disableAutomaticReconnection();
                }
                else
                {
                    setStatus (StreamStatus::State::connecting, juce::String::fromUTF8 ("A conexão caiu. Tentando de novo…"));
                }
                break;
            case ix::WebSocketMessageType::Error:
                live.store (false);
                setStatus (StreamStatus::State::connecting,
                           juce::String::fromUTF8 ("Não consegui falar com o servidor (") + juce::String (msg->errorInfo.reason) + "). Tentando de novo…");
                break;
            default:
                break;
        }
    });
    {
        std::lock_guard<std::mutex> g (wsLock);
        ws = std::move (socket);
        ws->start();
    }
    setStatus (StreamStatus::State::connecting, "Conectando…");
}

void Streamer::disconnect()
{
    live.store (false);
    std::unique_ptr<ix::WebSocket> old;
    {
        std::lock_guard<std::mutex> g (wsLock);
        old = std::move (ws);
    }
    if (old != nullptr)
        old->stop();
    std::lock_guard<std::mutex> g (lock);
    st = {};
    st.message = "Desconectado.";
}

void Streamer::onText (const std::string& text)
{
    const auto v = juce::JSON::parse (juce::String::fromUTF8 (text.c_str()));
    const auto t = v["t"].toString();
    std::lock_guard<std::mutex> g (lock);
    if (t == "ok")
    {
        resume = v["resume"].toString();
        pendingCode.clear();
        st.state = StreamStatus::State::connected;
        st.name = v["name"].toString();
        st.listeners = (int) v["listeners"];
        st.message = "Conectado.";
        dropped.store (0);
        live.store (true);
    }
    else if (t == "listeners")
    {
        st.listeners = (int) v["n"];
    }
    else if (t == "error")
    {
        live.store (false);
        st.state = StreamStatus::State::failed;
        st.message = v["message"].toString();
        // Código recusado: a chave de volta (se havia) também não vale mais.
        resume.clear();
    }
}

void Streamer::setStatus (StreamStatus::State s, const juce::String& msg)
{
    std::lock_guard<std::mutex> g (lock);
    // Um erro definitivo (código recusado) não é apagado pelas mensagens de reconexão.
    if (st.state == StreamStatus::State::failed && s == StreamStatus::State::connecting)
        return;
    st.state = s;
    st.message = msg;
}

juce::String Streamer::getResume() const
{
    std::lock_guard<std::mutex> g (lock);
    return resume;
}

void Streamer::setResume (const juce::String& r)
{
    std::lock_guard<std::mutex> g (lock);
    resume = r;
}

juce::String Streamer::getServer() const
{
    std::lock_guard<std::mutex> g (lock);
    return server;
}

StreamStatus Streamer::status() const
{
    std::lock_guard<std::mutex> g (lock);
    auto copy = st;
    copy.kbps = kbps.load();
    copy.dropped = dropped.load();
    return copy;
}

void Streamer::run()
{
    std::vector<float> chunk;
    std::string packet;
    auto windowStart = juce::Time::getMillisecondCounterHiRes();
    double windowBytes = 0;

    while (! threadShouldExit())
    {
        const auto now = juce::Time::getMillisecondCounterHiRes();
        if (now - windowStart >= 1000.0)
        {
            kbps.store (windowBytes * 8.0 / (now - windowStart));
            windowStart = now;
            windowBytes = 0;
        }

        if (! live.load())
        {
            // Sem conexão: esvazia a fila para não mandar som velho quando voltar.
            const int ready = fifo.getNumReady();
            if (ready > 0)
                fifo.read (ready);
            wait (10);
            continue;
        }

        const auto sampleRate = (std::uint32_t) std::lround (rate.load());
        if (! isSupportedRate (sampleRate))
        {
            setStatus (StreamStatus::State::failed,
                       juce::String::fromUTF8 ("Taxa de ") + juce::String (sampleRate) + juce::String::fromUTF8 (" Hz não suportada. Use 44,1, 48, 88,2, 96, 176,4 ou 192 kHz."));
            live.store (false);
            continue;
        }
        const int frames = (int) sampleRate / 100; // 10 ms
        if (fifo.getNumReady() < frames)
        {
            wait (2);
            continue;
        }

        const int ch = channels.load();
        chunk.resize ((size_t) frames * (size_t) ch);
        {
            const auto scope = fifo.read (frames);
            auto take = [&] (int start, int size, int offset) {
                for (int i = 0; i < size; ++i)
                    for (int c = 0; c < ch; ++c)
                        chunk[(size_t) (offset + i) * (size_t) ch + (size_t) c] = ring[(size_t) (start + i) * 2 + (size_t) c];
            };
            take (scope.startIndex1, scope.blockSize1, 0);
            take (scope.startIndex2, scope.blockSize2, scope.blockSize1);
        }

        const auto fmt = getFormat();
        encodePacket (packet, fmt, ch, sampleRate, seq++, chunk.data(), frames);
        const auto maxBacklog = (size_t) ((double) packet.size() * 100.0 * kMaxBacklogSeconds);
        std::lock_guard<std::mutex> g (wsLock);
        if (ws != nullptr && ws->bufferedAmount() < maxBacklog)
        {
            ws->sendBinary (packet);
            windowBytes += (double) packet.size();
        }
        else
        {
            dropped.fetch_add (1);
        }
    }
}
} // namespace noveau
