#include "PluginEditor.h"

namespace
{
    // As mesmas cores do site: metal escuro gasto, violeta discreto.
    const juce::Colour chassis { 0xff1b1b1d };
    const juce::Colour plate { 0xff262628 };
    const juce::Colour line { 0xff3a3a3d };
    const juce::Colour text { 0xffd9d6cf };
    const juce::Colour muted { 0xff8d8a84 };
    const juce::Colour accent { 0xff6c5ba3 };
    const juce::Colour ok { 0xff7fa864 };
    const juce::Colour warn { 0xffd09a3a };
    const juce::Colour bad { 0xffc0503f };

    juce::String u8 (const char* s) { return juce::String::fromUTF8 (s); }
} // namespace

NoveauEditor::NoveauEditor (NoveauProcessor& p) : AudioProcessorEditor (p), proc (p)
{
    look.setColour (juce::ResizableWindow::backgroundColourId, chassis);
    look.setColour (juce::TextEditor::backgroundColourId, juce::Colour (0xff09080c));
    look.setColour (juce::TextEditor::outlineColourId, line);
    look.setColour (juce::TextEditor::focusedOutlineColourId, accent);
    look.setColour (juce::TextEditor::textColourId, text);
    look.setColour (juce::ComboBox::backgroundColourId, plate);
    look.setColour (juce::ComboBox::outlineColourId, line);
    look.setColour (juce::ComboBox::textColourId, text);
    look.setColour (juce::PopupMenu::backgroundColourId, plate);
    look.setColour (juce::PopupMenu::textColourId, text);
    look.setColour (juce::PopupMenu::highlightedBackgroundColourId, accent);
    look.setColour (juce::TextButton::buttonColourId, plate);
    look.setColour (juce::TextButton::buttonOnColourId, accent);
    look.setColour (juce::TextButton::textColourOffId, text);
    look.setColour (juce::TextButton::textColourOnId, text);
    look.setColour (juce::Label::textColourId, text);
    setLookAndFeel (&look);

    title.setText (u8 ("noveau · DAW"), juce::dontSendNotification);
    title.setFont (juce::FontOptions (20.0f, juce::Font::italic));
    addAndMakeVisible (title);

    auto small = [] (juce::Label& l, const char* s) {
        l.setText (u8 (s), juce::dontSendNotification);
        l.setFont (juce::FontOptions (11.0f));
        l.setColour (juce::Label::textColourId, muted);
    };
    small (serverLabel, "SITE");
    small (codeLabel, u8 ("CÓDIGO DA SALA").toRawUTF8());
    small (formatLabel, "FORMATO");
    for (auto* l : { &serverLabel, &codeLabel, &formatLabel })
        addAndMakeVisible (*l);

    serverBox.setText (proc.serverText, false);
    serverBox.onTextChange = [this] { proc.serverText = serverBox.getText(); };
    addAndMakeVisible (serverBox);

    codeBox.setTextToShowWhenEmpty ("ABCD-1234", muted);
    codeBox.setInputRestrictions (9, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz23456789- ");
    codeBox.setFont (juce::FontOptions (18.0f));
    codeBox.setJustification (juce::Justification::centred);
    codeBox.onReturnKey = [this] { toggleConnection(); };
    addAndMakeVisible (codeBox);

    formatBox.addItem (u8 ("24-bit (padrão)"), 24);
    formatBox.addItem (u8 ("32-bit float (idêntico à DAW)"), 32);
    formatBox.addItem (u8 ("16-bit (mais leve)"), 16);
    formatBox.setSelectedId ((int) proc.streamer().getFormat(), juce::dontSendNotification);
    formatBox.onChange = [this] {
        const int id = formatBox.getSelectedId();
        proc.streamer().setFormat (id == 16 ? noveau::SampleFormat::int16 : id == 32 ? noveau::SampleFormat::float32 : noveau::SampleFormat::int24);
    };
    addAndMakeVisible (formatBox);

    connectButton.onClick = [this] { toggleConnection(); };
    addAndMakeVisible (connectButton);

    status.setFont (juce::FontOptions (14.0f));
    addAndMakeVisible (status);
    detail.setFont (juce::FontOptions (12.0f));
    detail.setColour (juce::Label::textColourId, muted);
    detail.setJustificationType (juce::Justification::topLeft);
    detail.setMinimumHorizontalScale (1.0f);
    addAndMakeVisible (detail);

    setSize (440, 300);
    timerCallback();
    startTimerHz (4);
}

NoveauEditor::~NoveauEditor()
{
    setLookAndFeel (nullptr);
}

void NoveauEditor::toggleConnection()
{
    auto& net = proc.streamer();
    const auto s = net.status().state;
    if (s == noveau::StreamStatus::State::connected || s == noveau::StreamStatus::State::connecting)
    {
        net.disconnect();
    }
    else
    {
        net.connect (serverBox.getText(), codeBox.getText().toUpperCase());
        codeBox.clear();
    }
    timerCallback();
}

void NoveauEditor::timerCallback()
{
    const auto st = proc.streamer().status();
    using S = noveau::StreamStatus::State;
    const bool active = st.state == S::connected || st.state == S::connecting;
    connectButton.setButtonText (active ? "Desconectar" : (codeBox.isEmpty() && proc.streamer().getResume().isNotEmpty() ? "Reconectar" : "Conectar"));
    codeBox.setEnabled (! active);
    serverBox.setEnabled (! active);

    juce::String head, more;
    switch (st.state)
    {
        case S::connected:
            led = ok;
            head = u8 ("Na sala como ") + st.name;
            more = juce::String (st.listeners) + (st.listeners == 1 ? u8 (" pessoa ouvindo") : u8 (" pessoas ouvindo"));
            more << u8 (" · ") << juce::String (st.kbps / 1000.0, 2).replace (".", ",") << " Mbps";
            if (st.dropped > 0)
                more << u8 (" · ") << st.dropped << u8 (" pacotes descartados (internet lenta)");
            more << "\n" << u8 ("O som passa por aqui sem alteração. Deixe o plugin no fim do master.");
            break;
        case S::connecting:
            led = warn;
            head = st.message;
            break;
        case S::failed:
            led = bad;
            head = st.message;
            break;
        case S::idle:
            led = juce::Colours::grey;
            head = u8 ("Desconectado");
            more = u8 ("No site, abra a tecla do plugin (barra de baixo), gere um código e digite aqui.");
            break;
    }
    status.setText (head, juce::dontSendNotification);
    detail.setText (more, juce::dontSendNotification);
    repaint();
}

void NoveauEditor::paint (juce::Graphics& g)
{
    g.fillAll (chassis);
    // Parafusos nos cantos, como no site.
    g.setColour (line);
    for (auto [x, y] : { std::pair { 10, 10 }, { getWidth() - 16, 10 }, { 10, getHeight() - 16 }, { getWidth() - 16, getHeight() - 16 } })
        g.fillEllipse ((float) x, (float) y, 6.0f, 6.0f);
    // LED do estado ao lado do texto.
    const auto b = status.getBounds();
    g.setColour (led);
    g.fillEllipse ((float) b.getX() - 14.0f, (float) b.getCentreY() - 4.0f, 8.0f, 8.0f);
}

void NoveauEditor::resized()
{
    auto r = getLocalBounds().reduced (22, 16);
    title.setBounds (r.removeFromTop (30));
    r.removeFromTop (6);

    auto row = r.removeFromTop (16);
    serverLabel.setBounds (row.removeFromLeft (r.getWidth() / 2));
    formatLabel.setBounds (row);
    row = r.removeFromTop (28);
    serverBox.setBounds (row.removeFromLeft (r.getWidth() / 2 - 6));
    row.removeFromLeft (12);
    formatBox.setBounds (row);
    r.removeFromTop (10);

    codeLabel.setBounds (r.removeFromTop (16));
    row = r.removeFromTop (36);
    connectButton.setBounds (row.removeFromRight (130));
    row.removeFromRight (10);
    codeBox.setBounds (row);
    r.removeFromTop (16);

    auto s = r.removeFromTop (22);
    s.removeFromLeft (16);
    status.setBounds (s);
    detail.setBounds (r.withTrimmedLeft (16));
}
