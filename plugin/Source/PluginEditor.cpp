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

    juce::String mbps (double kbps) { return juce::String (kbps / 1000.0, 1).replace (".", ",") + " Mbps"; }
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

    auto small = [] (juce::Label& l, const juce::String& s) {
        l.setText (s, juce::dontSendNotification);
        l.setFont (juce::FontOptions (11.0f));
        l.setColour (juce::Label::textColourId, muted);
    };
    small (codeLabel, u8 ("SALA FORA DO DISCORD? CÓDIGO DA SALA"));
    small (serverLabel, "SITE");
    small (formatLabel, "FORMATO");
    for (auto* l : { &codeLabel, &serverLabel, &formatLabel })
        addAndMakeVisible (*l);

    status.setFont (juce::FontOptions (16.0f, juce::Font::bold));
    addAndMakeVisible (status);
    detail.setFont (juce::FontOptions (12.5f));
    detail.setColour (juce::Label::textColourId, muted);
    detail.setJustificationType (juce::Justification::topLeft);
    detail.setMinimumHorizontalScale (1.0f);
    addAndMakeVisible (detail);

    mainButton.onClick = [this] { mainAction(); };
    addAndMakeVisible (mainButton);

    reopenButton.setButtonText (u8 ("abrir o navegador de novo"));
    reopenButton.onClick = [this] { openBrowser (proc.streamer().status().linkCode); };
    addChildComponent (reopenButton);

    codeBox.setTextToShowWhenEmpty ("ABCD-1234", muted);
    codeBox.setInputRestrictions (9, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz23456789- ");
    codeBox.setJustification (juce::Justification::centred);
    codeBox.onReturnKey = [this] { codeButton.triggerClick(); };
    addAndMakeVisible (codeBox);
    codeButton.setButtonText ("Usar");
    codeButton.onClick = [this] {
        if (codeBox.isEmpty())
            return;
        proc.useRoomCode (codeBox.getText());
        codeBox.clear();
        timerCallback();
    };
    addAndMakeVisible (codeButton);

    serverBox.setText (proc.getServerText(), false);
    serverBox.onTextChange = [this] { proc.setServerText (serverBox.getText()); };
    addAndMakeVisible (serverBox);

    formatBox.addItem (u8 ("24-bit (padrão)"), 24);
    formatBox.addItem (u8 ("32-bit float (idêntico)"), 32);
    formatBox.addItem (u8 ("16-bit (mais leve)"), 16);
    formatBox.setSelectedId ((int) proc.streamer().getFormat(), juce::dontSendNotification);
    formatBox.onChange = [this] {
        const int id = formatBox.getSelectedId();
        proc.streamer().setFormat (id == 16 ? noveau::SampleFormat::int16 : id == 32 ? noveau::SampleFormat::float32 : noveau::SampleFormat::int24);
    };
    addAndMakeVisible (formatBox);

    forgetButton.setButtonText (u8 ("sair da conta"));
    forgetButton.onClick = [this] {
        proc.forgetAccount();
        timerCallback();
    };
    addChildComponent (forgetButton);

    setSize (460, 340);
    timerCallback();
    startTimerHz (4);
}

NoveauEditor::~NoveauEditor()
{
    setLookAndFeel (nullptr);
}

void NoveauEditor::openBrowser (const juce::String& code)
{
    if (code.isEmpty())
        return;
    juce::URL (noveau::Streamer::siteUrl (proc.getServerText(), "/plugin?c=" + code)).launchInDefaultBrowser();
}

void NoveauEditor::mainAction()
{
    switch (action)
    {
        case Action::link:
            openOnCode = true;
            proc.linkDiscord();
            break;
        case Action::cancel:
            proc.streamer().disconnect();
            break;
        case Action::pause:
            proc.setSending (false);
            break;
        case Action::resume:
            proc.setSending (true);
            break;
    }
    timerCallback();
}

void NoveauEditor::timerCallback()
{
    const auto st = proc.streamer().status();
    using S = noveau::StreamStatus::State;
    const bool discord = st.mode == noveau::Mode::discord;
    const bool account = proc.hasAccount();

    // Código novo do servidor: abre o navegador uma vez (por clique).
    if (st.linkCode.isNotEmpty() && st.linkCode != lastCode)
    {
        lastCode = st.linkCode;
        if (openOnCode)
            openBrowser (st.linkCode);
        openOnCode = false;
    }

    juce::String head, more;
    switch (st.state)
    {
        case S::linking:
            led = warn;
            action = Action::cancel;
            head = u8 ("Confirme no navegador");
            more = u8 ("Abrimos a página do noveau. Clique em \"Conectar\" lá (entre com o Discord se pedir).\n")
                 + u8 ("Confira se o código é o mesmo: ") + st.linkCode;
            break;
        case S::connected:
            led = ok;
            action = Action::pause;
            if (discord && st.call.isEmpty())
            {
                led = warn;
                head = u8 ("Entre numa call do Discord");
                more = u8 ("Conectado como ") + st.name + u8 (". Assim que você entrar numa call, o som vai para quem abrir a sala dela no site.");
            }
            else
            {
                head = discord ? u8 ("Tocando na call ") + st.call : u8 ("Na sala como ") + st.name;
                if (st.listeners == 0)
                    more = u8 ("Ninguém ouvindo agora, então não está gastando internet. Quem abrir o site na ")
                         + (discord ? u8 ("call") : u8 ("sala")) + u8 (" já ouve.");
                else
                    more = juce::String (st.listeners) + (st.listeners == 1 ? u8 (" pessoa ouvindo") : u8 (" pessoas ouvindo"))
                         + u8 (" · ") + mbps (st.kbps);
                if (st.dropped > 0)
                    more << u8 (" · ") << st.dropped << u8 (" pacotes descartados (internet lenta)");
                more << "\n" << u8 ("O som passa sem alteração. Deixe o plugin no fim do master.");
            }
            break;
        case S::connecting:
            led = warn;
            action = Action::pause;
            head = st.message;
            break;
        case S::failed:
            led = bad;
            head = st.message;
            action = account || ! discord ? Action::resume : Action::link;
            if (! account && discord)
                more = u8 ("Clique em \"Conectar com o Discord\" para ligar de novo.");
            break;
        case S::idle:
            led = juce::Colours::grey;
            if (account && ! proc.isSending())
            {
                action = Action::resume;
                head = u8 ("Pausado neste projeto");
                more = u8 ("Conectado como ") + proc.accountName() + u8 (". O som deste projeto não sai daqui até você clicar em Transmitir.");
            }
            else if (account)
            {
                action = Action::resume;
                head = u8 ("Desconectado");
                more = u8 ("Conectado como ") + proc.accountName() + u8 (".");
            }
            else
            {
                action = Action::link;
                head = u8 ("Leve o som da DAW para a call");
                more = u8 ("Clique no botão abaixo. Você confirma com o Discord no navegador, só uma vez neste computador. ")
                     + u8 ("Depois disso o plugin segue sozinho a call em que você estiver.");
            }
            break;
    }

    const char* labels[] = { "Conectar com o Discord", "Cancelar", "Pausar", "Transmitir" };
    mainButton.setButtonText (u8 (labels[(int) action]));
    mainButton.setToggleState (action == Action::link || action == Action::resume, juce::dontSendNotification);
    reopenButton.setVisible (st.state == S::linking);
    forgetButton.setVisible (account);
    const bool busy = st.state == S::connected || st.state == S::connecting || st.state == S::linking;
    codeBox.setEnabled (! busy);
    codeButton.setEnabled (! busy);
    serverBox.setEnabled (! busy);

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
    // Linha separando o caminho normal (em cima) das opções (embaixo).
    g.setColour (line);
    g.fillRect (22, codeLabel.getY() - 8, getWidth() - 44, 1);
}

void NoveauEditor::resized()
{
    auto r = getLocalBounds().reduced (22, 16);
    auto top = r.removeFromTop (30);
    formatBox.setBounds (top.removeFromRight (170).withSizeKeepingCentre (170, 24));
    formatLabel.setBounds (formatBox.getBounds().translated (-62, 0).withWidth (58));
    title.setBounds (top);
    r.removeFromTop (12);

    auto s = r.removeFromTop (24);
    s.removeFromLeft (16);
    status.setBounds (s);
    detail.setBounds (r.removeFromTop (62).withTrimmedLeft (16));
    r.removeFromTop (6);

    auto row = r.removeFromTop (40);
    mainButton.setBounds (row);
    r.removeFromTop (4);
    row = r.removeFromTop (20);
    reopenButton.setBounds (row.withSizeKeepingCentre (200, 20));
    forgetButton.setBounds (row.removeFromRight (110));

    r.removeFromTop (18);
    codeLabel.setBounds (r.removeFromTop (16));
    row = r.removeFromTop (28);
    codeButton.setBounds (row.removeFromRight (70));
    row.removeFromRight (8);
    codeBox.setBounds (row.removeFromLeft (140));
    row.removeFromLeft (16);
    serverLabel.setBounds (row.removeFromLeft (32));
    serverBox.setBounds (row);
}
