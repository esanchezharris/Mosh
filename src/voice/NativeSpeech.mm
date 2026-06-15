#include "NativeSpeech.h"
#include <juce_events/juce_events.h>

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

NativeSpeech::NativeSpeech() : impl (std::make_unique<Impl>()) {}
NativeSpeech::~NativeSpeech() { stop(); }

bool NativeSpeech::isListening() const { return impl->listening; }

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

void NativeSpeech::stop()
{
   #if JUCE_MAC
    if (! impl->listening) return;
    impl->listening = false;
    impl->cleanupEngine();
    auto onStop = impl->cb.onStop;
    if (onStop) juce::MessageManager::callAsync ([onStop] { onStop(); });
   #endif
}

void NativeSpeech::start (Callbacks cb)
{
   #if JUCE_MAC
    if (impl->listening) return;
    impl->cb = std::move (cb);
    Impl* self = impl.get();

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

                self->request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
                self->request.shouldReportPartialResults = YES;
                if (self->recognizer.supportsOnDeviceRecognition)
                    self->request.requiresOnDeviceRecognition = YES;  // keep audio on-device when we can

                self->engine = [[AVAudioEngine alloc] init];
                AVAudioInputNode* input = self->engine.inputNode;
                AVAudioFormat* fmt = [input outputFormatForBus:0];
                SFSpeechAudioBufferRecognitionRequest* req = self->request;
                [input installTapOnBus:0 bufferSize:1024 format:fmt
                                 block:^(AVAudioPCMBuffer* buffer, AVAudioTime*) { [req appendAudioPCMBuffer:buffer]; }];

                [self->engine prepare];
                NSError* err = nil;
                if (! [self->engine startAndReturnError:&err])
                {
                    juce::String detail = err != nil ? juce::String ([[err localizedDescription] UTF8String])
                                                     : juce::String ("unknown");
                    return fail ("microphone capture failed: " + detail);
                }

                Callbacks cbCopy = self->cb;
                self->task = [self->recognizer recognitionTaskWithRequest:self->request
                    resultHandler:^(SFSpeechRecognitionResult* result, NSError* error)
                {
                    if (result != nil)
                    {
                        juce::String text ([[[result bestTranscription] formattedString] UTF8String]);
                        const bool isFinal = [result isFinal];
                        juce::MessageManager::callAsync ([cbCopy, text, isFinal]
                        {
                            if (isFinal) { if (cbCopy.onFinal)   cbCopy.onFinal (text); }
                            else         { if (cbCopy.onInterim) cbCopy.onInterim (text); }
                        });
                    }

                    const bool hadError = (error != nil);
                    const bool done = hadError || (result != nil && [result isFinal]);
                    if (done)
                    {
                        // Extract the message NOW — do not capture the NSError into the
                        // C++ lambda (ARC does not retain captures in std::function).
                        juce::String emsg = hadError ? juce::String ([[error localizedDescription] UTF8String])
                                                     : juce::String();
                        juce::MessageManager::callAsync ([self, hadError, emsg]
                        {
                            const bool wasListening = self->listening;
                            self->listening = false;
                            self->cleanupEngine();
                            if (hadError && wasListening && self->cb.onError) self->cb.onError (emsg);
                            if (self->cb.onStop) self->cb.onStop();
                        });
                    }
                }];

                self->listening = true;
                if (self->cb.onStart) self->cb.onStart();
            });
        }];
    }
    else
    {
        if (impl->cb.onError) impl->cb.onError ("speech recognition needs macOS 10.15 or later");
    }
   #else
    if (cb.onError) cb.onError ("native speech-to-text is unsupported on this platform");
   #endif
}

} // namespace mosh
