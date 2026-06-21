#include "NativeSpeech.h"
#include <juce_events/juce_events.h>
#include <atomic>

#if JUCE_MAC
 #import <Speech/Speech.h>
 #import <AVFoundation/AVFoundation.h>
#endif

namespace mosh
{

struct NativeSpeech::Impl
{
   #if JUCE_MAC
    SFSpeechRecognizer*                    recognizer = nil;
    AVAudioEngine*                         engine     = nil;
    SFSpeechAudioBufferRecognitionRequest* request    = nil;
    SFSpeechRecognitionTask*               task       = nil;
   #endif
    Callbacks cb;
    bool listening = false;
    bool continuous       = false; // always-on (hands-free) vs single-shot (hold-to-talk)
    bool producedSinceArm = false; // any result seen since the current request was armed?
    std::atomic<unsigned long> tapBuffers { 0 }; // mic buffers the tap has processed this session

   #if JUCE_MAC
    // Request permission, build the AVAudioEngine + mic tap, then arm(). The `continuous`
    // flag selects single-shot (hold-to-talk) vs always-on (hands-free) result handling.
    // The mic tap feeds `request` (the CURRENT one), so a recycle needs no graph change.
    void begin (bool continuousMode);

    // Build a FRESH recognition request + task and point request/task at them. Used for
    // the initial arm and — in continuous mode — to recycle after each endpointed phrase
    // or the ~1-min request cap. The engine + mic tap persist (the tap feeds `request`),
    // so a recycle re-targets capture with no audio-graph change. Message-thread only.
    void arm();
   #endif

    void cleanupEngine()
    {
       #if JUCE_MAC
        if (engine != nil)
        {
            if (engine.isRunning) [engine stop];
            @try { [engine.inputNode removeTapOnBus:0]; } @catch (NSException*) {}
        }
        if (request != nil) [request endAudio];
        if (task != nil)    [task cancel];
        engine = nil; request = nil; task = nil; recognizer = nil;
       #endif
    }
};

#if JUCE_MAC
void NativeSpeech::Impl::begin (bool continuousMode)
{
    continuous = continuousMode;
    tapBuffers.store (0, std::memory_order_relaxed);
    Impl* self = this;

    if (@available (macOS 10.15, *))
    {
        // Permission is async + may fire on an arbitrary thread; marshal everything
        // (including all AVAudioEngine setup) onto the message thread.
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status)
        {
            juce::MessageManager::callAsync ([self, status]
            {
                auto fail = [self] (const juce::String& m)
                {
                    self->listening = false;
                    self->cleanupEngine();
                    if (self->cb.onError) self->cb.onError (m);
                };

                if (status != SFSpeechRecognizerAuthorizationStatusAuthorized)
                    return fail ("speech recognition not authorized — enable it in "
                                 "System Settings › Privacy & Security › Speech Recognition");

                self->recognizer = [[SFSpeechRecognizer alloc] init];
                if (self->recognizer == nil || ! self->recognizer.isAvailable)
                    return fail ("no speech recognizer available for the current locale");

                self->engine = [[AVAudioEngine alloc] init];
                AVAudioInputNode* input = self->engine.inputNode;
                AVAudioFormat* fmt = [input outputFormatForBus:0];
                // The tap feeds the CURRENT request (read fresh per buffer) so a
                // continuous-mode recycle swaps requests with no audio-graph change.
                // Reading `self->request` here is a benign pointer race vs the recycle
                // (set on the message thread); the null-check covers the swap window.
                [input installTapOnBus:0 bufferSize:1024 format:fmt
                                 block:^(AVAudioPCMBuffer* buffer, AVAudioTime*)
                {
                    self->tapBuffers.fetch_add (1, std::memory_order_relaxed); // RT-safe diagnostic
                    SFSpeechAudioBufferRecognitionRequest* r = self->request;
                    if (r != nil) [r appendAudioPCMBuffer:buffer];
                }];

                [self->engine prepare];
                self->arm();   // build request+task BEFORE audio flows (no startup drop)

                NSError* err = nil;
                if (! [self->engine startAndReturnError:&err])
                {
                    juce::String detail = err != nil ? juce::String ([[err localizedDescription] UTF8String])
                                                     : juce::String ("unknown");
                    return fail ("microphone capture failed: " + detail);
                }

                self->listening = true;
                if (self->cb.onStart) self->cb.onStart();
            });
        }];
    }
    else
    {
        if (cb.onError) cb.onError ("speech recognition needs macOS 10.15 or later");
    }
}

void NativeSpeech::Impl::arm()
{
    producedSinceArm = false;

    request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    request.shouldReportPartialResults = YES;
    if (recognizer.supportsOnDeviceRecognition)
        request.requiresOnDeviceRecognition = YES;   // keep audio on-device + dodge net rate limits

    Impl* self = this;
    task = [recognizer recognitionTaskWithRequest:request
        resultHandler:^(SFSpeechRecognitionResult* result, NSError* error)
    {
        // Pull everything out of the ObjC objects HERE (don't capture NSError/NSResult
        // into the C++ lambda — ARC won't retain them), then marshal to the message
        // thread where all NativeSpeech state lives.
        const bool hasResult = (result != nil);
        juce::String text = hasResult ? juce::String ([[[result bestTranscription] formattedString] UTF8String])
                                      : juce::String();
        const bool isFinal  = hasResult && [result isFinal];
        const bool hadError = (error != nil);
        juce::String emsg   = hadError ? juce::String ([[error localizedDescription] UTF8String]) : juce::String();

        juce::MessageManager::callAsync ([self, hasResult, text, isFinal, hadError, emsg]
        {
            if (! self->listening) return;        // a stop() raced us — ignore late callbacks

            if (hasResult)
            {
                self->producedSinceArm = true;
                if (isFinal) { if (self->cb.onFinal)   self->cb.onFinal (text); }
                else         { if (self->cb.onInterim) self->cb.onInterim (text); }
            }

            const bool done = hadError || isFinal;
            if (! done) return;

            // Continuous: a routine phrase-end or the ~1-min request cap recycles the
            // request+task while the engine + tap stay hot. A FATAL case (an error with
            // nothing produced this arm, or a dead engine) stops — this guard is what
            // prevents a hot-loop if the recognizer keeps erroring immediately.
            const bool fatal = (hadError && ! self->producedSinceArm)
                            || self->engine == nil || ! self->engine.isRunning;
            if (self->continuous && ! fatal)
            {
                if (self->request != nil) [self->request endAudio];
                if (self->task != nil)    [self->task cancel];
                self->request = nil; self->task = nil;
                self->arm();                       // fresh request+task; keep listening
                return;
            }

            const bool wasListening = self->listening;
            self->listening = false;
            self->cleanupEngine();
            if (hadError && wasListening && self->cb.onError) self->cb.onError (emsg);
            if (self->cb.onStop) self->cb.onStop();
        });
    }];
}
#endif

NativeSpeech::NativeSpeech() : impl (std::make_unique<Impl>()) {}
NativeSpeech::~NativeSpeech() { stop(); }

bool NativeSpeech::isListening() const { return impl->listening; }

unsigned long NativeSpeech::tapBufferCount() const { return impl->tapBuffers.load (std::memory_order_relaxed); }

bool NativeSpeech::isSupported()
{
   #if JUCE_MAC
    if (@available (macOS 10.15, *))
    {
        SFSpeechRecognizer* r = [[SFSpeechRecognizer alloc] init];
        return r != nil;
    }
   #endif
    return false;
}

int NativeSpeech::authorizationStatus()
{
   #if JUCE_MAC
    if (@available (macOS 10.15, *))
        return (int) [SFSpeechRecognizer authorizationStatus];   // 0 notDet · 1 denied · 2 restricted · 3 authorized
   #endif
    return -1;
}

void NativeSpeech::stop()
{
   #if JUCE_MAC
    if (! impl->listening) return;
    impl->listening = false;
    impl->continuous = false;
    impl->cleanupEngine();
    auto onStop = impl->cb.onStop;
    if (onStop) juce::MessageManager::callAsync ([onStop] { onStop(); });
   #endif
}

void NativeSpeech::stopContinuous() { stop(); }

void NativeSpeech::start (Callbacks cb)
{
   #if JUCE_MAC
    if (impl->listening) return;
    impl->cb = std::move (cb);
    impl->begin (/*continuousMode=*/ false);   // single-shot — ends on the first phrase
   #else
    if (cb.onError) cb.onError ("native speech-to-text is unsupported on this platform");
   #endif
}

void NativeSpeech::startContinuous (Callbacks cb)
{
   #if JUCE_MAC
    if (impl->listening) return;
    impl->cb = std::move (cb);
    impl->begin (/*continuousMode=*/ true);    // always-on — recycles after each phrase
   #else
    if (cb.onError) cb.onError ("native speech-to-text is unsupported on this platform");
   #endif
}

void NativeSpeech::transcribeFile (const juce::String& audioPath, Callbacks cbIn)
{
   #if JUCE_MAC
    impl->cb = std::move (cbIn);
    Impl* self = impl.get();
    const juce::String path = audioPath;

    if (@available (macOS 10.15, *))
    {
        // Same on-device recognizer as the live path, but reading a FILE instead of the
        // mic — so the smoke proves STT end-to-end with nobody speaking. Permission is
        // async + may fire off-thread; marshal everything to the message thread.
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status)
        {
            juce::MessageManager::callAsync ([self, status, path]
            {
                if (status != SFSpeechRecognizerAuthorizationStatusAuthorized)
                {
                    if (self->cb.onError)
                        self->cb.onError ("speech recognition not authorized — grant it once "
                                          "(System Settings › Privacy & Security › Speech Recognition)");
                    return;
                }
                SFSpeechRecognizer* rec = [[SFSpeechRecognizer alloc] init];
                if (rec == nil || ! rec.isAvailable)
                {
                    if (self->cb.onError) self->cb.onError ("no speech recognizer available for the current locale");
                    return;
                }
                NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.toRawUTF8()]];
                SFSpeechURLRecognitionRequest* req = [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
                if (rec.supportsOnDeviceRecognition)
                    req.requiresOnDeviceRecognition = YES;   // on-device + dodge net rate limits

                if (self->cb.onStart) self->cb.onStart();

                [rec recognitionTaskWithRequest:req
                    resultHandler:^(SFSpeechRecognitionResult* result, NSError* error)
                {
                    const bool hasResult = (result != nil);
                    juce::String text = hasResult ? juce::String ([[[result bestTranscription] formattedString] UTF8String])
                                                  : juce::String();
                    const bool isFinal  = hasResult && [result isFinal];
                    const bool hadError = (error != nil);
                    juce::String emsg   = hadError ? juce::String ([[error localizedDescription] UTF8String]) : juce::String();

                    juce::MessageManager::callAsync ([self, text, isFinal, hadError, emsg]
                    {
                        if (isFinal)
                        {
                            if (self->cb.onFinal) self->cb.onFinal (text);
                            if (self->cb.onStop)  self->cb.onStop();
                        }
                        else if (hadError)
                        {
                            if (self->cb.onError) self->cb.onError (emsg);
                            if (self->cb.onStop)  self->cb.onStop();
                        }
                    });
                }];
            });
        }];
    }
    else if (cbIn.onError)
    {
        cbIn.onError ("speech recognition needs macOS 10.15 or later");
    }
   #else
    if (cbIn.onError) cbIn.onError ("native speech-to-text is unsupported on this platform");
   #endif
}

} // namespace mosh
