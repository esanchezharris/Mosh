#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
/**
    Moshi's brain, server side — the native equivalent of the Vite `/api/brain/chat`
    dev proxy. In the packaged app the WebView has no dev server, so this performs
    the LLM chat round-trip in C++: it resolves an OpenAI-compatible provider from
    the ENVIRONMENT (so API keys never reach the WebView / client bundle) and POSTs
    the chat completion.

    Mirrors the dev proxy exactly (ui/vite.config.ts → moshiBrain):
      • providers: deepseek | openai | xai, each via <PREFIX>_BASE_URL / _API_KEY / _MODEL
      • default: MOSHI_BRAIN_PROVIDER if fully configured, else the first complete one
      • request: POST {url}/chat/completions, response_format=json_object, max 800 tokens
      • OpenAI reasoning models (gpt-5/6, o-series) use max_completion_tokens + no temp

    The bridge calls chat() OFF the message thread (it blocks on HTTP) and resolves
    the WebView promise with the returned var.
*/
struct BrainProxy
{
    struct Provider
    {
        juce::String id, label, url, key, model;
        bool isComplete() const { return key.isNotEmpty() && url.isNotEmpty() && model.isNotEmpty(); }
    };

    /** The three known providers with their env-resolved fields (regardless of
        whether they are fully configured). Order: deepseek, openai, xai. */
    static juce::Array<Provider> providers();

    /** Pick the provider to use: `requested` if it is complete, else
        MOSHI_BRAIN_PROVIDER if complete, else the first complete provider. Returns a
        Provider with empty fields (isComplete()==false) when none is configured. */
    static Provider resolve (const juce::String& requested = {});

    /** Blocking chat round-trip. `messages` is a JSON array of {role,content}.
        Returns { ok:true, content, provider, model, ms } on success, or
        { ok:false, error } on any failure (no provider / network / upstream). Call
        OFF the message thread. */
    static juce::var chat (const juce::var& messages, const juce::String& requested = {});

    /** Diagnostics for a future picker / the log: which providers are configured. */
    static juce::var providersInfo();
};

} // namespace mosh
