#pragma once
#include <juce_audio_processors/juce_audio_processors.h>

#include "PluginProcessor.h"

/** Tela do plugin: endereço do site, código, formato e o estado da conexão. */
class NoveauEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit NoveauEditor (NoveauProcessor&);
    ~NoveauEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void toggleConnection();

    NoveauProcessor& proc;
    juce::LookAndFeel_V4 look;
    juce::Label title, serverLabel, codeLabel, formatLabel, status, detail;
    juce::TextEditor serverBox, codeBox;
    juce::ComboBox formatBox;
    juce::TextButton connectButton;
    juce::Colour led { juce::Colours::grey };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NoveauEditor)
};
