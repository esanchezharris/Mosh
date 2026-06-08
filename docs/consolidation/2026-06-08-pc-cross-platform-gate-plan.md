# ClaudeMosh PC / Cross-Platform Gate Plan - 2026-06-08

## Summary

This is a documentation-only gate plan. It does not start Windows/Linux porting
or change product code. The current Mac v0 remains the release authority until
the Mac matrix is green and a Windows gate can replace each Mac-only proof with
a concrete equivalent or a documented deferral.

## Gate Split

| Current Mac proof | PC / cross-platform equivalent | Policy |
| --- | --- | --- |
| Hosted `macos-15` smoke CI | Hosted Windows smoke CI on `windows-2025` or `windows-latest` | Add only after CMake/toolchain feasibility is known |
| Self-hosted Mac full gate | Self-hosted Windows full gate on a labeled local PC runner | Manual and non-required until it passes once |
| CoreAudio + BlackHole live proof | Windows WASAPI/ASIO loopback proof using a virtual cable or driver-backed loopback | Required before Windows audio release claims |
| AX/Quartz GUI automation | Windows UI Automation or WinAppDriver-style inspection/action gate | Required for native GUI claims; CUA inspection remains additive |
| Serum/VST3 native editor proof on macOS | Windows VST3 scan/load/editor proof with the same licensed plugin or a declared test plugin | Required before plugin-host parity claims |
| SA3/MLX local model path | Windows-compatible generative service path or explicit SA3-on-Mac-only deferral | Defer unless a non-MLX backend is selected |
| Apple TCC permissions | Windows runner desktop-session, audio-device, and UI-automation permissions | Must be preflighted before full gate |

## Proposed Windows Gate Layers

1. Hosted smoke gate:
   - Checkout with HTTPS rewrite for Tracktion submodules.
   - Install Node 24, CMake, Ninja, and ripgrep.
   - Run `npm --prefix ui ci` and `npm --prefix ui run build`.
   - Configure CMake only after the source tree supports non-macOS generators.
   - Run command-log/schema checks that do not require native audio or GUI.

2. Self-hosted Windows full gate:
   - Use labels `self-hosted`, `Windows`, `X64`, `mosh-local-pc`.
   - Preflight virtual loopback device, plugin directories, runner desktop
     session, and service port ownership.
   - Run the Windows native build, command selftests, live-audio loopback, and
     GUI automation only after those scripts exist.

3. Deferral ledger:
   - MLX/SA3 remains Mac-only unless a Windows backend is chosen.
   - Physical speaker and microphone proof remains out of scope unless a later
     release target requires it.
   - Networked Mac-to-PC collaboration is separate from native Windows support.

## Acceptance Criteria

- No Windows release claim is made until a Windows hosted smoke gate and one
  local Windows full-gate evidence set exist.
- Every Mac-only proof in the edge matrix has a Windows replacement, a script
  name planned for that replacement, or a clear deferral.
- Branch protection continues to require `Hosted macOS smoke`; Windows checks
  become required only after they pass reliably on pull requests.

## Next Implementation Boundary

The next implementation task should be a feasibility branch, not a product port:

- Audit CMake/JUCE/Tracktion assumptions that hard-code macOS or arm64.
- Add a Windows CI skeleton only if it can run without making false green
  claims.
- Keep runtime audio, plugin, GUI, and generative parity out of scope until the
  first hosted Windows configure/build problem is understood.
