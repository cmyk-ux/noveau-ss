#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace
{
    juce::PropertiesFile::Options settingsOptions()
    {
        // Windows: %APPDATA%\noveau\noveau DAW.settings · Mac: ~/Library/Application Support/noveau/
        juce::PropertiesFile::Options o;
        o.applicationName = "noveau DAW";
        o.filenameSuffix = ".settings";
        o.folderName = "noveau";
        o.osxLibrarySubFolder = "Application Support";
        o.millisecondsBeforeSaving = 0;
        return o;
    }
} // namespace

NoveauProcessor::NoveauProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Entrada", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Saída", juce::AudioChannelSet::stereo(), true))
{
    settings.setStorageParameters (settingsOptions());
    if (auto* s = settings.getUserSettings())
        serverText = s->getValue ("server", serverText);

    net.onKey = [this] (noveau::Mode mode, const juce::String& key, const juce::String& name) {
        // Vem da thread de rede: guarda no message thread.
        juce::MessageManager::callAsync ([safe = juce::WeakReference<NoveauProcessor> (this), mode, key, name] {
            auto* self = safe.get();
            if (self == nullptr)
                return;
            if (mode == noveau::Mode::discord)
                self->saveAccount (key, name);
            else
            {
                const juce::ScopedLock g (self->stateLock);
                self->roomKey = key;
            }
        });
    };
    // A DAW manda o estado do projeto logo depois de criar o plugin. Espera um instante para
    // saber se este projeto estava pausado ou usando código de sala antes de conectar.
    startTimer (400);
}

NoveauProcessor::~NoveauProcessor()
{
    stopTimer();
    net.onKey = nullptr;
    net.disconnect();
}

void NoveauProcessor::timerCallback()
{
    stopTimer();
    if (! started)
        startFromSaved();
}

void NoveauProcessor::startFromSaved()
{
    started = true;
    juce::String server, key;
    bool room = false;
    {
        const juce::ScopedLock g (stateLock);
        if (! sending)
            return;
        server = serverText;
        room = usingRoom;
        key = roomKey;
    }
    if (room)
    {
        if (key.isNotEmpty())
            net.connectKey (server, noveau::Mode::room, key);
        return;
    }
    if (auto* s = settings.getUserSettings())
    {
        const auto account = s->getValue ("discordKey");
        if (account.isNotEmpty())
            net.connectKey (server, noveau::Mode::discord, account);
    }
}

void NoveauProcessor::saveAccount (const juce::String& key, const juce::String& name)
{
    if (auto* s = settings.getUserSettings())
    {
        if (key.isEmpty())
        {
            s->removeValue ("discordKey");
            s->removeValue ("discordName");
        }
        else
        {
            s->setValue ("discordKey", key);
            s->setValue ("discordName", name);
            s->setValue ("server", getServerText());
        }
        s->saveIfNeeded();
    }
}

bool NoveauProcessor::hasAccount() const
{
    auto* s = const_cast<juce::ApplicationProperties&> (settings).getUserSettings();
    return s != nullptr && s->getValue ("discordKey").isNotEmpty();
}

juce::String NoveauProcessor::accountName() const
{
    auto* s = const_cast<juce::ApplicationProperties&> (settings).getUserSettings();
    return s != nullptr ? s->getValue ("discordName") : juce::String();
}

juce::String NoveauProcessor::getServerText() const
{
    const juce::ScopedLock g (stateLock);
    return serverText;
}

void NoveauProcessor::setServerText (const juce::String& s)
{
    const juce::ScopedLock g (stateLock);
    serverText = s;
}

void NoveauProcessor::linkDiscord()
{
    started = true;
    {
        const juce::ScopedLock g (stateLock);
        usingRoom = false;
        sending = true;
    }
    net.connectLink (getServerText());
}

void NoveauProcessor::useRoomCode (const juce::String& code)
{
    started = true;
    {
        const juce::ScopedLock g (stateLock);
        usingRoom = true;
        sending = true;
        roomKey.clear();
    }
    net.connectCode (getServerText(), code);
}

void NoveauProcessor::setSending (bool on)
{
    {
        const juce::ScopedLock g (stateLock);
        sending = on;
        if (on && ! usingRoom && ! hasAccount())
            usingRoom = roomKey.isNotEmpty();
    }
    if (on)
        startFromSaved();
    else
        net.disconnect();
}

void NoveauProcessor::forgetAccount()
{
    net.disconnect();
    saveAccount ({}, {});
}

bool NoveauProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto out = layouts.getMainOutputChannelSet();
    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;
    return layouts.getMainInputChannelSet() == out;
}

void NoveauProcessor::prepareToPlay (double sampleRate, int)
{
    net.prepare (sampleRate, getTotalNumInputChannels());
}

void NoveauProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    // Canais de saída a mais (não acontece com mono/estéreo, mas por garantia) ficam em silêncio.
    for (auto ch = getTotalNumInputChannels(); ch < getTotalNumOutputChannels(); ++ch)
        buffer.clear (ch, 0, buffer.getNumSamples());
    net.push (buffer);
}

juce::AudioProcessorEditor* NoveauProcessor::createEditor()
{
    return new NoveauEditor (*this);
}

void NoveauProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::ValueTree state ("noveau");
    {
        const juce::ScopedLock g (stateLock);
        state.setProperty ("server", serverText, nullptr);
        state.setProperty ("sending", sending, nullptr);
        state.setProperty ("room", usingRoom, nullptr);
        // Chave da sala (modo código): reconecta sozinho ao reabrir o projeto (vale 24 h).
        state.setProperty ("roomKey", roomKey, nullptr);
    }
    state.setProperty ("format", (int) net.getFormat(), nullptr);
    juce::MemoryOutputStream out (destData, false);
    state.writeToStream (out);
}

void NoveauProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    const auto state = juce::ValueTree::readFromData (data, (size_t) sizeInBytes);
    if (! state.isValid())
        return;
    const int f = state.getProperty ("format", 24);
    net.setFormat (f == 16 ? noveau::SampleFormat::int16 : f == 32 ? noveau::SampleFormat::float32 : noveau::SampleFormat::int24);
    {
        const juce::ScopedLock g (stateLock);
        serverText = state.getProperty ("server", serverText).toString();
        sending = state.getProperty ("sending", true);
        usingRoom = state.getProperty ("room", false);
        roomKey = state.getProperty ("roomKey").toString();
    }
    // Chegou depois de já ter conectado (algumas DAWs mandam o estado mais tarde): refaz.
    if (started)
    {
        net.disconnect();
        started = false;
        startTimer (50);
    }
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new NoveauProcessor();
}
