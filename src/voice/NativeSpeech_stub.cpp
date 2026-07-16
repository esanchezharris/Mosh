// Non-Apple stub for mosh::NativeSpeech.
//
// The real implementation (NativeSpeech.mm) is Objective-C++ over Apple's
// Speech.framework + AVAudioEngine and only compiles/links on macOS. On Windows
// (and any other non-Apple target) this translation unit provides the SAME public
// surface declared in NativeSpeech.h so the rest of the app links: native
// speech-to-text reports unsupported and every entry point is a safe no-op. The
// browser Web Speech path (ui/src/agent/voiceInput.ts) and a future whisper.cpp
// backend can sit behind this identical interface without any UI change.

#include "NativeSpeech.h"

namespace mosh
{

// Empty pimpl so the std::unique_ptr<Impl> member has a complete type to destroy.
struct NativeSpeech::Impl {};

NativeSpeech::NativeSpeech()  = default;
NativeSpeech::~NativeSpeech() = default;

bool NativeSpeech::isSupported() { return false; }

int NativeSpeech::authorizationStatus() { return -1; }   // header contract: -1 on non-macOS

void NativeSpeech::start (Callbacks cb)
{
    if (cb.onError)
        cb.onError ("native speech-to-text is unsupported on this platform");
}

void NativeSpeech::transcribeFile (const juce::String&, Callbacks cb)
{
    if (cb.onError)
        cb.onError ("native speech-to-text is unsupported on this platform");
}

void NativeSpeech::startContinuous (Callbacks cb)
{
    if (cb.onError)
        cb.onError ("native speech-to-text is unsupported on this platform");
}

void NativeSpeech::stop()           {}
void NativeSpeech::stopContinuous() {}

bool          NativeSpeech::isListening()    const { return false; }
unsigned long NativeSpeech::tapBufferCount() const { return 0; }

} // namespace mosh
