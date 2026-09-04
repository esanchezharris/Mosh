#include "MacFileBookmark.h"

#import <Foundation/Foundation.h>

namespace mosh::mac
{
juce::String createFileBookmark (const juce::File& file, juce::String& error)
{
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:
        file.getFullPathName().toRawUTF8()]];
    NSError* nativeError = nil;
    NSData* data = [url bookmarkDataWithOptions:0
                 includingResourceValuesForKeys:nil
                                  relativeToURL:nil
                                          error:&nativeError];
    if (data == nil)
    {
        error = nativeError != nil
            ? juce::String ([[nativeError localizedDescription] UTF8String])
            : juce::String ("could not create a persistent folder bookmark");
        return {};
    }
    return juce::String ([[data base64EncodedStringWithOptions:0] UTF8String]);
}

juce::File resolveFileBookmark (const juce::String& bookmark)
{
    NSString* encoded = [NSString stringWithUTF8String:bookmark.toRawUTF8()];
    NSData* data = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
    if (data == nil)
        return {};

    BOOL stale = NO;
    NSError* error = nil;
    NSURL* url = [NSURL URLByResolvingBookmarkData:data
                                          options:(NSURLBookmarkResolutionWithoutUI
                                                   | NSURLBookmarkResolutionWithoutMounting)
                                    relativeToURL:nil
                              bookmarkDataIsStale:&stale
                                            error:&error];
    juce::ignoreUnused (stale, error);
    if (url == nil || ! [url isFileURL])
        return {};
    return juce::File (juce::String ([[url path] UTF8String]));
}
}
