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

    /** Current Speech-Recognition authorization, SYNCHRONOUS (no prompt). Maps
        SFSpeechRecognizerAuthorizationStatus: 0 notDetermined · 1 denied · 2 restricted
        · 3 authorized. -1 on non-macOS. Lets a headless caller bail cleanly when the
        grant is missing instead of entering the async path. */
    static int authorizationStatus();

    /** Request permission (once) and begin capturing + transcribing. Safe to call
        again while idle; a no-op while already listening. Single-shot: the recognizer
        ends on the first endpointed phrase (onFinal → onStop). Drives hold-to-talk. */
    void start (Callbacks cb);

    /** Like start(), but ALWAYS-ON: emits Callbacks::onFinal once per endpointed phrase
        and keeps listening (recycling the recognition request after each phrase / the
        ~1-min request cap) until stopContinuous(). Drives hands-free mode. The mic +
        AVAudioEngine tap persist across recycles, so this can run concurrently with the
        DAW's own audio input (barge-in) — see Callbacks. */
    void startContinuous (Callbacks cb);

    /** Stop capture; the final transcript is delivered via Callbacks::onFinal. */
    void stop();

    /** Stop an always-on (continuous) session and release the mic. */
    void stopContinuous();

    bool isListening() const;

    /** Number of microphone buffers the capture tap has processed this session — a
        diagnostic the barge-in live-smoke uses to prove the recognizer actually captured
        audio CONCURRENTLY with the DAW's own input recording (not merely that the engine
        started). Reset on each start()/startContinuous(). 0 on non-macOS. */
    unsigned long tapBufferCount() const;

    /** One-shot FILE transcription (SFSpeechURLRecognitionRequest) for the headless
        voice smoke (`Mosh --voice-smoke`). Transcribes an audio file on-device and
        delivers the text via Callbacks::onFinal (or onError), on the message thread.
        Needs Speech-Recognition authorization but NO microphone — it proves the STT
        engine end-to-end on a known phrase with nobody speaking. No-op on non-macOS. */
    void transcribeFile (const juce::String& audioPath, Callbacks cb);

private:
    struct Impl;
    std::unique_ptr<Impl> impl;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (NativeSpeech)
};

} // namespace mosh
