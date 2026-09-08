import { useState } from "react";
import { nativeRequest, readAgentContext } from "../agent/loop/nativeTask";
import type { NativeExecution } from "../agent/loop/nativeTask";
import { executionPresentation } from "../agent/loop/boundedProposal";
import { useProducerRack, validateProducerRack } from "../agent/loop/producerRack";
import { useTaskStore } from "../agent/loop/taskStore";

export function ProducerRackSetup() {
  const rack = useProducerRack((state) => state.rack);
  const setRack = useProducerRack((state) => state.setRack);
  const running = useTaskStore((state) => state.current !== null);
  const [context, setContext] = useState<Awaited<ReturnType<typeof readAgentContext>> | null>(null);
  const [lead, setLead] = useState("");
  const [room, setRoom] = useState("");
  const [pluginIndex, setPluginIndex] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [requestId, setRequestId] = useState("");
  const [request, setRequest] = useState<NativeExecution | null>(null);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [recordedRequests, setRecordedRequests] = useState<NativeExecution[]>([]);
  const tracks = context?.snapshot.tracks.filter((track) => track.type === "audio" && !track.isGroup && !track.isReturn) ?? [];
  const filters = tracks.find((track) => track.id === lead)?.plugins?.filter((plugin) => plugin.type === "highpass" && plugin.builtin && !plugin.external) ?? [];

  const read = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const fresh = await readAgentContext();
      setContext(fresh);
      setRecordedRequests(fresh.requests);
      const selected = rack?.projectId === fresh.projectId ? rack : null;
      setLead(selected?.leadTrackId ?? "");
      setRoom(selected?.roomTrackId ?? "");
      setPluginIndex(selected ? String(selected.pluginIndex) : "");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setMessage(error.message);
    } finally { setBusy(false); }
  };

  const enable = async () => {
    if (!context || !lead || !room || pluginIndex === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const fresh = await readAgentContext();
      if (fresh.projectId !== context.projectId || fresh.epoch !== context.epoch) {
        setMessage("The project changed. Read the current tracks again.");
        setContext(null);
        return;
      }
      const selected = { projectId: fresh.projectId, leadTrackId: lead, roomTrackId: room, pluginIndex: Number(pluginIndex) };
      const problem = validateProducerRack(fresh.snapshot, selected, [], "initial");
      if (problem) { setMessage(problem); return; }
      setRack(selected);
      setContext(fresh);
      setMessage("Producer rack enabled for this project. No audio settings were changed.");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setMessage(error.message);
    } finally { setBusy(false); }
  };

  const lookupRequest = async () => {
    if (!requestId.trim()) return;
    setBusy(true);
    setRequest(null);
    setRequestMessage(null);
    try {
      const fresh = await readAgentContext();
      const result = await nativeRequest("get_agent_request", { projectId: fresh.projectId, requestId: requestId.trim() });
      setRequest(result);
      setRequestMessage(result.error ?? null);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setRequestMessage(error.message);
    } finally { setBusy(false); }
  };

  const discoverRequests = async () => {
    setBusy(true);
    setRequestMessage(null);
    try {
      const fresh = await readAgentContext();
      setRecordedRequests(fresh.requests);
      setRequest(null);
      setRequestId("");
      setRequestMessage(fresh.requests.length ? "Select a recorded request to inspect its native outcome." : "No recorded requests in this project.");
    } catch (error) {
      setRequestMessage(error instanceof Error ? error.message : "Native request inventory unavailable");
    } finally { setBusy(false); }
  };

  const resolveRequest = async () => {
    if (!request || (request.status !== "prepared" && request.status !== "unresolved")) return;
    setBusy(true);
    setRequestMessage(null);
    try {
      const fresh = await readAgentContext();
      if (fresh.projectId !== request.projectId) { setRequestMessage("The project changed. Look up the request in its original project."); return; }
      const result = await nativeRequest("cancel_agent_request", { projectId: request.projectId, requestId: request.requestId });
      setRequest(result);
      setRequestMessage(result.error ?? (result.status === "cancelled" ? "The native engine confirmed no outstanding changes for this request." : executionPresentation(result, false).say));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setRequestMessage(error.message);
    } finally { setBusy(false); }
  };

  return <details data-testid="producer-rack-setup">
    <summary>Producer rack {rack ? "configured" : "off"}</summary>
    <p>Choose the existing lead, its native high-pass, and the printed-room audio track. Compression is excluded.</p>
    <button className="btn" data-testid="producer-rack-read" disabled={busy || running} onClick={() => void read()}>Read current tracks</button>
    {context && <fieldset disabled={busy || running}>
      <legend>Allowed controls for this project</legend>
      <label className="pop-row"><span>Lead vocal track</span>
        <select data-testid="producer-rack-lead" value={lead} onChange={(event) => { setLead(event.target.value); setPluginIndex(""); }}>
          <option value="">Choose lead</option>
          {tracks.map((track) => <option key={track.id} value={track.id}>{track.name} · {track.index + 1}</option>)}
        </select>
      </label>
      <label className="pop-row"><span>Existing high-pass</span>
        <select data-testid="producer-rack-filter" value={pluginIndex} onChange={(event) => setPluginIndex(event.target.value)}>
          <option value="">Choose high-pass</option>
          {filters.map((plugin) => <option key={plugin.index} value={plugin.index}>{plugin.name} · insert {plugin.index + 1}</option>)}
        </select>
      </label>
      <label className="pop-row"><span>Printed-room track</span>
        <select data-testid="producer-rack-room" value={room} onChange={(event) => setRoom(event.target.value)}>
          <option value="">Choose printed room</option>
          {tracks.filter((track) => track.id !== lead).map((track) => <option key={track.id} value={track.id}>{track.name} · {track.index + 1}</option>)}
        </select>
      </label>
      <p>Lead −6, 0, or +3 dB; high-pass bypass, 80, or 120 Hz; printed room 0 or −6 dB.</p>
      <button className="btn" data-testid="producer-rack-enable" disabled={!lead || !room || pluginIndex === ""} onClick={() => void enable()}>Enable selected rack</button>
    </fieldset>}
    {rack && <button className="btn" data-testid="producer-rack-disable" disabled={busy || running} onClick={() => { setRack(null); setMessage("Producer rack disabled. Audio settings were preserved."); }}>Disable rack</button>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    <fieldset disabled={busy || running}>
      <legend>Request status in the current project</legend>
      <button className="btn" data-testid="producer-request-discover" onClick={() => void discoverRequests()}>Find project requests</button>
      {recordedRequests.length > 0 && <label className="pop-row"><span>Recorded request</span>
        <select data-testid="producer-request-select" value={requestId} onChange={(event) => {
          setRequestId(event.target.value); setRequest(null); setRequestMessage(null);
        }}>
          <option value="">Choose a request</option>
          {recordedRequests.map((recorded) => <option key={recorded.requestId} value={recorded.requestId}>{recorded.requestId} · {recorded.status}</option>)}
        </select>
      </label>}
      <label className="pop-row"><span>Logical request ID</span>
        <input data-testid="producer-request-id" value={requestId} onChange={(event) => { setRequestId(event.target.value); setRequest(null); setRequestMessage(null); }} />
      </label>
      <button className="btn" data-testid="producer-request-lookup" disabled={!requestId.trim()} onClick={() => void lookupRequest()}>Look up request</button>
      {request && <p data-testid="producer-request-status" role="status">{request.status} · {request.appliedCount} recorded applied command(s)</p>}
      {request?.status === "prepared" && <button className="btn" data-testid="producer-request-resolve" onClick={() => void resolveRequest()}>Cancel unapplied request</button>}
      {request?.status === "unresolved" && <>
        <p>After restoring the original state through session recovery, ask the native engine to verify it. A mismatch leaves this request unresolved.</p>
        <button className="btn" data-testid="producer-request-resolve" onClick={() => void resolveRequest()}>Resolve restored pre-state</button>
      </>}
      {requestMessage && <p role="status" aria-live="polite">{requestMessage}</p>}
    </fieldset>
  </details>;
}
