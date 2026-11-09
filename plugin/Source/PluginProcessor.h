#pragma once
#include <juce_audio_processors/juce_audio_processors.h>

#include "Streamer.h"

/** O plugin não mexe no som: deixa passar igual e manda uma cópia para a sala. */
class NoveauProcessor : public juce::AudioProcessor
{
public:
    NoveauProcessor();
    ~NoveauProcessor() override = default;

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

    /** Endereço do site digitado na tela do plugin (salvo no projeto). */
    juce::String serverText { "noveau.riajuu.net" };

private:
    noveau::Streamer net;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NoveauProcessor)
};
