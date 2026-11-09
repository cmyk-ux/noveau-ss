#include "PluginProcessor.h"
#include "PluginEditor.h"

NoveauProcessor::NoveauProcessor()
    : AudioProcessor (BusesProperties()
                          .withInput ("Entrada", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Saída", juce::AudioChannelSet::stereo(), true))
{
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
    state.setProperty ("server", serverText, nullptr);
    state.setProperty ("format", (int) net.getFormat(), nullptr);
    // Chave de volta: com ela o plugin reconecta sozinho ao reabrir o projeto (vale 24 h).
    state.setProperty ("resume", net.getResume(), nullptr);
    state.setProperty ("connected", net.status().state == noveau::StreamStatus::State::connected, nullptr);
    juce::MemoryOutputStream out (destData, false);
    state.writeToStream (out);
}

void NoveauProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    const auto state = juce::ValueTree::readFromData (data, (size_t) sizeInBytes);
    if (! state.isValid())
        return;
    serverText = state.getProperty ("server", serverText).toString();
    const int f = state.getProperty ("format", 24);
    net.setFormat (f == 16 ? noveau::SampleFormat::int16 : f == 32 ? noveau::SampleFormat::float32 : noveau::SampleFormat::int24);
    net.setResume (state.getProperty ("resume").toString());
    if ((bool) state.getProperty ("connected", false) && net.getResume().isNotEmpty())
        net.connect (serverText, {});
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new NoveauProcessor();
}
