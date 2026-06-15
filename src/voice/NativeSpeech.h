#pragma once

#include <juce_core/juce_core.h>
#include <functional>
#include <memory>

namespace mosh
{
/**
    Native speech-to-text for the packaged app (macOS Speech.framework).

    The web/dev path uses the browser Web Speech API (ui/src/agent/voiceInput.ts);
    WKWebView does not expose it, so in the packaged app we drive SFSpeechRecognizer
    + AVAudioEngine here and surface the SAME shape the UI already consumes:
    start → interim transcripts → final transcript (on stop), plus stop/error.

    The bridge funnels these to the UI as a `voice_event` so voiceInput.ts can pick a
    native backend transparently. whisper.cpp could replace this impl behind the same
    interface without any UI change.

    Threading: all callbacks are marshalled to the message thread (the bridge's
    emitEvent is message-thread-only). start()/stop() must be called on the message
    thread. Non-macOS builds compile to a stub that reports unsupported.
*/
class NativeSpeech
{
public:
    struct Callbacks
    {
        std::function<void()>                     onStart;   // mic is hot
        std::function<void (const juce::String&)> onInterim; // live partial transcript
        std::function<void (const juce::String&)> onFinal;   // committed transcript
        std::function<void()>                     onStop;    // capture ended (any reason)
        std::function<void (const juce::String&)> onError;   // permission / engine failure
    };

    NativeSpeech();
    ~NativeSpeech();

    /** True when the Speech framework + a recognizer for the current locale exist.
        Does NOT imply the user has granted permission (that is requested on start). */
    static bool isSupported();

    /** Request permission (once) and begin capturing + transcribing. Safe to call
        again while idle; a no-op while already listening. */
    void start (Callbacks cb);

    /** Stop capture; the final transcript is delivered via Callbacks::onFinal. */
    void stop();

    bool isListening() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NativeSpeech)
};

} // namespace mosh
