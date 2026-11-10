// Fotografa a tela do plugin em cada estado (para conferir o layout sem DAW).
//   editor_shot <servidor> <pasta>   (o e2e do navegador confirma o pedido no meio)
#include "PluginEditor.h"

#include <cstdio>

static void shot (juce::Component& c, const juce::File& f)
{
    const auto img = c.createComponentSnapshot (c.getLocalBounds(), true, 2.0f);
    f.deleteFile();
    juce::FileOutputStream out (f);
    juce::PNGImageFormat().writeImageToStream (img, out);
    std::printf ("SHOT %s\n", f.getFullPathName().toRawUTF8());
    std::fflush (stdout);
}

int main (int argc, char** argv)
{
    if (argc < 3)
        return 2;
    juce::ScopedJuceInitialiser_GUI gui;
    const juce::File dir { juce::String (argv[2]) };
    auto pump = [] (int ms) { juce::MessageManager::getInstance()->runDispatchLoopUntil (ms); };

    NoveauProcessor proc;
    proc.forgetAccount();
    proc.setServerText (argv[1]);
    pump (600);
    std::unique_ptr<juce::AudioProcessorEditor> ed (proc.createEditor());
    ed->setVisible (true);
    pump (400);
    shot (*ed, dir.getChildFile ("editor-1-inicio.png"));

    proc.linkDiscord();
    for (int i = 0; i < 50 && proc.streamer().status().linkCode.isEmpty(); ++i)
        pump (100);
    std::printf ("LINK %s\n", proc.streamer().status().linkCode.toRawUTF8());
    std::fflush (stdout);
    pump (400);
    shot (*ed, dir.getChildFile ("editor-2-confirmar.png"));

    for (int i = 0; i < 300 && proc.streamer().status().state != noveau::StreamStatus::State::connected; ++i)
        pump (100);
    pump (1500);
    shot (*ed, dir.getChildFile ("editor-3-tocando.png"));

    proc.setSending (false);
    pump (500);
    shot (*ed, dir.getChildFile ("editor-4-pausado.png"));
    ed.reset();
    proc.forgetAccount();
    return 0;
}
