#pragma once

namespace mosh
{
class MoshEngine;
class MoshOps;

// Headless "agent server": reads JSON-lines on stdin, routes each to the ONE
// MoshOps command seam, writes one response line per request to stdout (prefixed
// `@@MOSH@@` so a parent harness can ignore library/engine noise on the same pipe).
// This is how the production arena lets an external agent drive the REAL engine
// end-to-end (no WebView). Synchronous on the message thread, mirroring runSelfTest;
// `render_layer{wait:true}` blocks inline just as it does there.
//
// Protocol (one JSON object per line):
//   {"command":"create_track","args":{"name":"Drums"}}  -> {"ok":true,...}
//   {"op":"snapshot"}                                    -> the full snapshot
//   {"op":"quit"}  or EOF                                -> exit 0
int runAgentServer (MoshEngine& engine, MoshOps& ops);
}
