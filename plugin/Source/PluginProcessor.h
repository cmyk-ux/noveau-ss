#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_data_structures/juce_data_structures.h>

#include "Streamer.h"

/**
 * O plugin não mexe no som: deixa passar igual e manda uma cópia para quem está ouvindo.
 *
 * Ligado à conta do Discord, a chave fica guardada no computador (não no projeto): qualquer
 * projeto em que o plugin for colocado já sai tocando para a call em que a pessoa estiver.
 * Com código de sala, a chave fica no projeto (vale 24 h).
 */
class NoveauProcessor : public juce::AudioProcessor, private juce::Timer
{
public:
    NoveauProcessor();
    ~NoveauProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    noveau::Streamer& streamer() { return net; }

    // ---- o que a tela do plugin pede ----
    /** Liga à conta do Discord (abre o navegador para confirmar). */
    void linkDiscord();
    /** Entra numa sala com o código do site. */
    void useRoomCode (const juce::String& code);
    /** Liga ou pausa o envio neste projeto. */
    void setSending (bool on);
    bool isSending() const { return sending; }
    /** Esquece a conta do Discord neste computador. */
    void forgetAccount();
    bool hasAccount() const;
    juce::String accountName() const;
    juce::String getServerText() const;
    void setServerText (const juce::String& s);

private:
    void timerCallback() override;
    void saveAccount (const juce::String& key, const juce::String& name);
    void startFromSaved();

    noveau::Streamer net;
    juce::ApplicationProperties settings;
    mutable juce::CriticalSection stateLock;
    juce::String serverText { "noveau.riajuu.net" };
    juce::String roomKey;          // chave da sala (modo código), guardada no projeto
    bool usingRoom = false;        // este projeto usa código de sala em vez da conta
    bool sending = true;           // pausado neste projeto?
    std::atomic<bool> started { false };

    JUCE_DECLARE_WEAK_REFERENCEABLE (NoveauProcessor)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NoveauProcessor)
};
