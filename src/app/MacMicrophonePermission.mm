#include "MacMicrophonePermission.h"

#import <AVFoundation/AVFoundation.h>

#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>

namespace mosh::mac
{
MicrophonePermissionStatus requestMicrophonePermission (int timeoutMs)
{
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio])
    {
        case AVAuthorizationStatusAuthorized:
            return MicrophonePermissionStatus::granted;
        case AVAuthorizationStatusDenied:
            return MicrophonePermissionStatus::denied;
        case AVAuthorizationStatusRestricted:
            return MicrophonePermissionStatus::restricted;
        case AVAuthorizationStatusNotDetermined:
            break;
    }

    struct PermissionState
    {
        std::mutex mutex;
        std::condition_variable condition;
        bool finished = false;
        bool granted = false;
    };
    auto state = std::make_shared<PermissionState>();

    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                            completionHandler:^ (BOOL allowed)
    {
        {
            std::lock_guard lock (state->mutex);
            state->granted = allowed;
            state->finished = true;
        }
        state->condition.notify_one();
    }];

    if ([NSThread isMainThread])
    {
        const auto deadline = std::chrono::steady_clock::now()
                            + std::chrono::milliseconds (timeoutMs);
        for (;;)
        {
            {
                std::lock_guard lock (state->mutex);
                if (state->finished)
                    return state->granted ? MicrophonePermissionStatus::granted
                                          : MicrophonePermissionStatus::denied;
            }

            if (std::chrono::steady_clock::now() >= deadline)
                return MicrophonePermissionStatus::timedOut;

            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                      beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
    }

    std::unique_lock lock (state->mutex);
    if (! state->condition.wait_for (lock, std::chrono::milliseconds (timeoutMs),
                                     [&state] { return state->finished; }))
        return MicrophonePermissionStatus::timedOut;
    return state->granted ? MicrophonePermissionStatus::granted
                          : MicrophonePermissionStatus::denied;
}
}
