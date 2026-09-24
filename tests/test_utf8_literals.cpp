// N3 (2026-09-23 real-app walkthrough) -- no non-ASCII bytes inside C++ string literals.
//
// The Booth showed `Ready â<ctrl><ctrl> takes land on "Vocal · Takes"`. The literal was
// `"Ready — takes land on \"" + name`: a `const char*` on the LEFT of `+` goes through
// juce::String's ASCII constructor (it asserts, then widens every byte > 127 as Latin-1),
// while the same bytes on the RIGHT of `+` are appended as UTF-8 and come out fine. The
// same literal is right or wrong depending on which side of an operator it sits, so
// reviewing call sites one by one does not scale. The rule this file enforces instead:
//
//   * a C++ string or character literal in src/ never contains a raw byte > 127
//     (comments may say anything), and
//   * a non-ASCII character is spelled as \x escapes INSIDE juce::CharPointer_UTF8 (...)
//     or juce::String::fromUTF8 (...), the idiom the codebase already used, e.g.
//     juce::String (juce::CharPointer_UTF8 ("wave audio \xe2\x80\x94 import MIDI")).
//     A high escape anywhere else is the same bug with extra steps (MenuController.cpp
//     already records "\xe2\x80\xa6" decoding to "â¦" in an NSMenu title).
//
// Objective-C @"..." literals are exempt: clang decodes those as UTF-8 NSStrings.
// Scanning happens on the real tree (MOSH_SOURCE_DIR_STRING), and the scanner itself is
// pinned first on small inputs so a scanner that sees nothing cannot pass vacuously.
#include <catch2/catch_test_macros.hpp>
#include <juce_core/juce_core.h>

#include <string>
#include <vector>

namespace
{
struct Violation
{
    int line = 0;
    std::string literal;
    std::string why;
};

struct ScanResult
{
    int literals = 0;
    std::vector<Violation> violations;
};

bool isIdentChar (char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

bool isHexDigit (char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

int hexValue (char c)
{
    return c <= '9' ? c - '0' : (c >= 'a' ? c - 'a' + 10 : c - 'A' + 10);
}

/** True when an escape sequence inside `body` encodes a byte > 127 (\x80-\xff, \200-\377). */
bool hasHighEscape (const std::string& body)
{
    for (size_t i = 0; i + 1 < body.size(); ++i)
    {
        if (body[i] != '\\')
            continue;
        const char e = body[i + 1];
        if (e == 'x')
        {
            int value = 0;
            size_t j = i + 2;
            while (j < body.size() && isHexDigit (body[j]))
                value = value * 16 + hexValue (body[j++]);
            if (value > 127)
                return true;
            i = j - 1;
        }
        else if (e >= '0' && e <= '7')
        {
            int value = 0;
            size_t j = i + 1;
            for (int n = 0; n < 3 && j < body.size() && body[j] >= '0' && body[j] <= '7'; ++n)
                value = value * 8 + (body[j++] - '0');
            if (value > 127)
                return true;
            i = j - 1;
        }
        else
        {
            ++i;   // \\, \", \n ... : skip the escaped character
        }
    }
    return false;
}

/** Strips whitespace from the tail of the code seen so far and asks whether the literal
    about to start is the direct argument of a UTF-8 decoding call. */
bool followsUtf8Wrapper (const std::string& codeTail)
{
    std::string squeezed;
    for (char c : codeTail)
        if (c != ' ' && c != '\t' && c != '\n' && c != '\r')
            squeezed += c;
    auto endsWith = [&] (const char* s)
    {
        const std::string suffix (s);
        return squeezed.size() >= suffix.size()
            && squeezed.compare (squeezed.size() - suffix.size(), suffix.size(), suffix) == 0;
    };
    return endsWith ("CharPointer_UTF8(") || endsWith ("fromUTF8(");
}

ScanResult scanSource (const std::string& src)
{
    ScanResult out;
    const size_t n = src.size();
    size_t i = 0;
    int line = 1;
    std::string code;                    // code outside comments and literal bodies
    bool codeSinceLiteral = true;        // non-blank code since the previous literal ended?
    bool groupWrapped = false;           // the current adjacent-literal group is wrapped

    auto record = [&] (int atLine, const std::string& full, const std::string& body, bool rawString, bool objc)
    {
        ++out.literals;
        const bool wrapped = codeSinceLiteral ? followsUtf8Wrapper (code.size() > 80 ? code.substr (code.size() - 80) : code)
                                              : groupWrapped;
        groupWrapped = wrapped;
        codeSinceLiteral = false;
        if (objc)
            return;
        for (unsigned char c : body)
            if (c > 127)
            {
                out.violations.push_back ({ atLine, full, "raw non-ASCII byte in a literal" });
                return;
            }
        if (! rawString && ! wrapped && hasHighEscape (body))
            out.violations.push_back ({ atLine, full, "high \\x escape outside CharPointer_UTF8/fromUTF8" });
    };

    while (i < n)
    {
        const char c = src[i];
        if (c == '\n')
        {
            ++line; code += c; ++i;
            continue;
        }
        if (c == '/' && i + 1 < n && src[i + 1] == '/')
        {
            while (i < n && src[i] != '\n') ++i;
            continue;
        }
        if (c == '/' && i + 1 < n && src[i + 1] == '*')
        {
            i += 2;
            while (i + 1 < n && ! (src[i] == '*' && src[i + 1] == '/'))
            {
                if (src[i] == '\n') ++line;
                ++i;
            }
            i = juce::jmin (n, i + 2);
            code += ' ';
            continue;
        }
        // Raw string: an optional u8/u/U/L prefix, then R"delim( ... )delim"
        {
            size_t p = i;
            if (src.compare (p, 2, "u8") == 0) p += 2;
            else if (src[p] == 'u' || src[p] == 'U' || src[p] == 'L') p += 1;
            if (p + 1 < n && src[p] == 'R' && src[p + 1] == '"' && (i == 0 || ! isIdentChar (src[i - 1])))
            {
                const size_t open = src.find ('(', p + 2);
                if (open != std::string::npos && open - (p + 2) <= 16)
                {
                    const std::string close = ")" + src.substr (p + 2, open - (p + 2)) + "\"";
                    size_t end = src.find (close, open + 1);
                    if (end == std::string::npos) end = n;
                    const int startLine = line;
                    const std::string body = src.substr (open + 1, end - open - 1);
                    for (char b : body) if (b == '\n') ++line;
                    const size_t stop = juce::jmin (n, end + close.size());
                    record (startLine, src.substr (i, stop - i), body, true, false);
                    i = stop;
                    continue;
                }
            }
        }
        const bool digitSeparator = c == '\'' && i > 0 && i + 1 < n
                                    && isHexDigit (src[i - 1]) && isHexDigit (src[i + 1])
                                    && ! (i + 2 < n && src[i + 2] == '\'');
        if ((c == '"' || c == '\'') && ! digitSeparator)
        {
            const bool objc = c == '"' && i > 0 && src[i - 1] == '@';
            size_t j = i + 1;
            while (j < n && src[j] != c && src[j] != '\n')
                j += (src[j] == '\\') ? 2 : 1;
            j = juce::jmin (j, n);
            const std::string body = src.substr (i + 1, j - i - 1);
            record (line, src.substr (i, juce::jmin (n, j + 1) - i), body, false, objc);
            i = (j < n && src[j] == c) ? j + 1 : j;
            continue;
        }
        if (! juce::CharacterFunctions::isWhitespace ((juce::juce_wchar) (unsigned char) c))
            codeSinceLiteral = true;
        code += c;
        if (code.size() > 4096) code.erase (0, code.size() - 256);
        ++i;
    }
    return out;
}

ScanResult scan (const char* text) { return scanSource (std::string (text)); }
} // namespace

TEST_CASE ("utf8 literals: the scanner flags a raw UTF-8 byte in a literal, with its line", "[utf8-literals]")
{
    const auto r = scan ("int a;\nauto s = \"Ready \xe2\x80\x94 go\";\n");
    REQUIRE (r.violations.size() == 1);
    CHECK (r.violations[0].line == 2);
    CHECK (r.literals == 1);
}

TEST_CASE ("utf8 literals: comments may say anything", "[utf8-literals]")
{
    const auto r = scan ("// a line comment \xe2\x80\x94 with \"quotes\"\n"
                         "/* a block \xe2\x80\x94 comment with 'an apostrophe' */\n"
                         "auto s = \"ascii\";\n");
    CHECK (r.violations.empty());
    CHECK (r.literals == 1);
}

TEST_CASE ("utf8 literals: escapes inside CharPointer_UTF8 / fromUTF8 are the sanctioned spelling", "[utf8-literals]")
{
    CHECK (scan ("auto s = juce::String (juce::CharPointer_UTF8 (\"a \\xe2\\x80\\x94 b\"));").violations.empty());
    CHECK (scan ("auto s = juce::String::fromUTF8 (\"a \\xc2\\xb7 b\");").violations.empty());
    // An adjacent-literal group inherits its wrapper.
    CHECK (scan ("auto s = juce::CharPointer_UTF8 (\"a \\xe2\\x80\\x94 \"\n   \"b \\xc2\\xb7\");").violations.empty());
}

TEST_CASE ("utf8 literals: a high escape outside a UTF-8 wrapper is the same bug", "[utf8-literals]")
{
    CHECK (scan ("juce::String s (\"a \\xe2\\x80\\xa6\");").violations.size() == 1);
    CHECK (scan ("auto s = \"\\342\\200\\224\";").violations.size() == 1);
    CHECK (scan ("auto s = \"\\x7f and \\101\";").violations.empty());   // <= 127 is ASCII
    CHECK (scan ("auto s = \"a backslash then x: \\\\xe2\";").violations.empty());
}

TEST_CASE ("utf8 literals: quoting edge cases do not derail the scanner", "[utf8-literals]")
{
    // An escaped quote does not end the literal, so the dash after it is still inside.
    CHECK (scan ("auto s = \"say \\\"hi\\\" \xe2\x80\x94 now\";").violations.size() == 1);
    // Raw strings, including one containing a bare quote.
    CHECK (scan ("auto s = R\"(raw \xe2\x80\x94 string)\";").violations.size() == 1);
    CHECK (scan ("auto s = R\"x(has \" a quote)x\"; auto t = \"ok\";").violations.empty());
    // Digit separators are not character literals.
    CHECK (scan ("int n = 1'000'000; auto s = \"\xe2\x80\x94\";").violations.size() == 1);
    // A character literal is a literal too.
    CHECK (scan ("char c = '\\xe2';").violations.size() == 1);
    // Objective-C NSString literals are decoded as UTF-8 by clang.
    CHECK (scan ("NSString* s = @\"Starting\xe2\x80\xa6\";").violations.empty());
}

TEST_CASE ("utf8 literals: no string literal in src/ carries a non-ASCII byte", "[utf8-literals]")
{
    const juce::File srcDir = juce::File (MOSH_SOURCE_DIR_STRING).getChildFile ("src");
    REQUIRE (srcDir.isDirectory());

    int files = 0, literals = 0;
    juce::StringArray report;
    for (const auto& entry : juce::RangedDirectoryIterator (srcDir, true, "*.cpp;*.h;*.hpp;*.mm;*.m;*.cc",
                                                             juce::File::findFiles))
    {
        const auto file = entry.getFile();
        juce::MemoryBlock bytes;
        if (! file.loadFileAsData (bytes))
            continue;
        ++files;
        const auto result = scanSource (std::string (static_cast<const char*> (bytes.getData()), bytes.getSize()));
        literals += result.literals;
        for (const auto& v : result.violations)
            report.add (file.getRelativePathFrom (srcDir.getParentDirectory()) + ":" + juce::String (v.line)
                        + ": " + juce::String (v.why) + ": " + juce::String::fromUTF8 (v.literal.c_str()).substring (0, 100));
    }

    INFO ("scanned " << files << " files, " << literals << " literals");
    // Anti-vacuity: the scan really read the tree (a wrong root would find nothing and pass).
    CHECK (files > 150);
    CHECK (literals > 20000);
    INFO (report.joinIntoString ("\n").toStdString());
    CHECK (report.size() == 0);
}
