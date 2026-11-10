#pragma once
#include <juce_audio_processors/juce_audio_processors.h>

#include "PluginProcessor.h"

/**
 * Tela do plugin. O caminho normal é um botão só: "Conectar com o Discord" abre o navegador,
 * a pessoa confirma e pronto. O código de sala fica embaixo, para salas fora do Discord.
 */
class NoveauEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit NoveauEditor (NoveauProcessor&);
    ~NoveauEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void mainAction();
    void openBrowser (const juce::String& code);

    enum class Action { link, cancel, pause, resume };
    Action action = Action::link;

    NoveauProcessor& proc;
    juce::LookAndFeel_V4 look;
    juce::Label title, status, detail, codeLabel, serverLabel, formatLabel;
    juce::TextButton mainButton, reopenButton, codeButton, forgetButton;
    juce::TextEditor codeBox, serverBox;
    juce::ComboBox formatBox;
    juce::Colour led { juce::Colours::grey };
    bool openOnCode = false;     // a pessoa clicou em conectar: abre o navegador quando o código chegar
    juce::String lastCode;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NoveauEditor)
};
