#pragma once

#include <juce_core/juce_core.h>

namespace mosh
{
/** Immutable launch policy with a process-scoped transport-attempt budget.
    This is a loopback rehearsal guard, not a dollar cap or live-provider allowance.
    Failed attempts consume their reservation; there is no reset or refund API. */
class BrainTrialPolicy
{
public:
    explicit BrainTrialPolicy (const char* environmentValue) : enabled (environmentValue != nullptr)
    {
        if (! enabled)
            return;

        const auto config = juce::JSON::parse (juce::String (environmentValue));
        const auto* object = config.getDynamicObject();
        if (object == nullptr || object->getProperties().size() != 5)
            return;

        const auto id = config.getProperty ("provider", {});
        const auto modelValue = config.getProperty ("model", {});
        const auto urlValue = config.getProperty ("baseUrl", {});
        const auto count = config.getProperty ("maxCalls", {});
        const auto loopback = config.getProperty ("loopbackOnly", {});
        if (! id.isString() || ! modelValue.isString() || ! urlValue.isString()
            || ! (count.isInt() || count.isInt64()) || (juce::int64) count < 0
            || ! loopback.isBool() || ! (bool) loopback)
            return;

        provider = id.toString();
        model = modelValue.toString();
        baseUrl = urlValue.toString();
        if (! juce::StringArray { "local", "deepseek", "openai", "xai", "openrouter" }.contains (provider)
            || model.trim().isEmpty() || ! isLiteralLoopbackUrl (baseUrl))
            return;

        maximumCalls = (juce::int64) count;
        valid = true;
    }

    bool isEnabled() const { return enabled; }
    bool isValid() const { return valid; }
    const juce::String& providerId() const { return provider; }

    juce::String reserve (const juce::String& requested, const juce::String& configuredProvider,
                          const juce::String& configuredModel, const juce::String& configuredUrl)
    {
        if (! enabled)
            return {};
        if (! valid)
            return "brain trial: invalid MOSH_BRAIN_TRIAL_POLICY";
        if ((requested.isNotEmpty() && requested != provider) || configuredProvider != provider
            || configuredModel != model || configuredUrl != baseUrl)
            return "brain trial: provider, model or endpoint does not match the launch policy";

        const juce::ScopedLock lock (counterLock);
        if (attemptedCalls >= maximumCalls)
            return "brain trial: native call budget exhausted";
        ++attemptedCalls;
        return {};
    }

private:
    static bool isLiteralLoopbackUrl (const juce::String& url)
    {
        const juce::String prefix = "http://127.0.0.1:";
        if (! url.startsWith (prefix))
            return false;
        const auto remainder = url.substring (prefix.length());
        const auto slash = remainder.indexOfChar ('/');
        const auto port = slash < 0 ? remainder : remainder.substring (0, slash);
        if (port.isEmpty() || port.length() > 5 || ! port.containsOnly ("0123456789")
            || port.getIntValue() < 1 || port.getIntValue() > 65535)
            return false;
        // Restrict the path spelling so URL parsing cannot change the literal authority.
        return slash < 0 || remainder.substring (slash).containsOnly (
            "/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.");
    }

    const bool enabled;
    bool valid = false;
    juce::String provider, model, baseUrl;
    juce::int64 maximumCalls = 0, attemptedCalls = 0;
    juce::CriticalSection counterLock;
};
}
