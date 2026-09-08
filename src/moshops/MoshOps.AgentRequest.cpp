#include "MoshOps.h"
#include "engine/SessionPaths.h"
#include <cstdlib>

namespace mosh
{
using namespace juce;

namespace
{
var object (std::initializer_list<std::pair<const char*, var>> values)
{
    auto* result = new DynamicObject();
    for (const auto& value : values) result->setProperty (value.first, value.second);
    return var (result);
}

bool agentFaultArmed (MoshEngine& engine, const String& variable, const String& requestId)
{
    const auto session = SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {});
    return agentrequest::faultAllowed (
        sessionpaths::isOwnedHarnessSession (sessionpaths::moshDataDirectory (true), engine.sessionDir()),
        session, SystemStats::getEnvironmentVariable (variable, {}), requestId);
}

void agentCrashPoint (MoshEngine& engine, const String& point, const String& requestId)
{
    if (agentFaultArmed (engine, "MOSH_AGENT_CRASH_REQUEST", requestId)
        && SystemStats::getEnvironmentVariable ("MOSH_AGENT_CRASH_POINT", {}) == point)
        std::_Exit (86);
}
}

String MoshOps::agentProjectId() const
{
    return agenttxn::digestOf (eng.editFile().getFullPathName());
}

void MoshOps::initAgentRequests()
{
    for (const auto& line : StringArray::fromLines (txnLedgerFile.loadFileAsString()))
        if (auto record = agentrequest::fromLedger (JSON::parse (line)))
        {
            if (record->status == "committed" || record->status == "unresolved"
                || record->status == "rolled_back" || record->status == "undone")
                agentRestartCheck_ = record->status == "committed" ? record->requestId : String();
            agentRequests_[record->requestId] = *record;
        }
    if (! eng.wasUncleanShutdown()) agentRestartCheck_.clear();
}

bool MoshOps::persistAgentRequest (const agentrequest::Record& record)
{
    FileOutputStream stream (txnLedgerFile);
    if (! stream.openedOk()) return false;
    const auto line = JSON::toString (agentrequest::toLedger (record), true) + "\n";
    if (! stream.writeText (line, false, false, "\n")) return false;
    stream.flush();
    return stream.getStatus().wasOk();
}

bool MoshOps::removeAgentRecoveryRows (const agentrequest::Record& record)
{
    if (recoveryJournalFile.existsAsFile())
    {
        const auto prior = recoveryJournalFile.loadFileAsString();
        const auto retained = agentrequest::removeOwnedJournalRows (prior, record.requestId, record.projectId);
        if (retained != prior && ! recoveryJournalFile.replaceWithText (retained)) return false;
    }
    for (int i = pendingRecovery_.size(); --i >= 0;)
    {
        const auto row = JSON::parse (pendingRecovery_[i]);
        if (row["agentRequestId"].toString() == record.requestId
            && row["agentProjectId"].toString() == record.projectId) pendingRecovery_.remove (i);
    }
    return true;
}

var MoshOps::agentRequestStatus (agentrequest::Record& record, bool replayed)
{
    if (record.requestId == agentRestartCheck_ && record.projectId == agentProjectId())
    {
        agentRestartCheck_.clear();
        if (record.postFingerprint.isEmpty() || txnFingerprint() != record.postFingerprint)
        {
            record.status = "unresolved";
            persistAgentRequest (record);
        }
    }
    if (record.status == "unresolved" && record.nativeCommitted && record.projectId == agentProjectId()
        && record.postFingerprint.isNotEmpty() && txnFingerprint() == record.postFingerprint)
    {
        record.status = "committed";
        persistAgentRequest (record);
    }
    syncUndoMirror();
    const bool undoable = record.status == "committed" && record.epoch == agentEpoch_
        && record.projectId == agentProjectId() && record.historyTxn == currentHistoryTxn()
        && undoManager().getUndoDescription() == agenttxn::labelFor (record.transactionId)
        && undoManager().getNumActionsInCurrentTransaction() > 0 && ! inBatch;
    auto status = object ({ { "requestId", record.requestId }, { "projectId", record.projectId },
                           { "status", record.status }, { "appliedCount", record.appliedCount },
                           { "undoable", undoable }, { "replayed", replayed },
                           { "inProgress", record.status == "prepared" && ! record.loaded } });
    if (! record.results.isEmpty()) status.getDynamicObject()->setProperty ("results", record.results);
    return status;
}

var MoshOps::cmdAgentRequest (const String& command, const var& args)
{
    if (command == "get_agent_context")
    {
        const auto projectId = agentProjectId();
        Array<var> requests;
        for (auto& item : agentRequests_)
            if (item.second.projectId == projectId) requests.add (agentRequestStatus (item.second));
        return okResult (command, object ({ { "projectId", projectId }, { "requests", requests },
                          { "epoch", agentEpoch_ }, { "revision", editRevision_ }, { "snapshot", snapshot() } }));
    }

    const auto id = args["requestId"].toString();
    const auto project = args["projectId"].toString();
    if (! agentrequest::validId (id) || project.isEmpty())
        return errResult (command, "invalid_request_identity");
    if (project != agentProjectId()) return errResult (command, "project_conflict");
    auto found = agentRequests_.find (id);
    if (found == agentRequests_.end())
    {
        if (command != "begin_agent_request") return errResult (command, "unknown_request");
        if (! args.hasProperty ("payload")) return errResult (command, "payload_required");
        if (agentRequests_.size() >= 4096) return errResult (command, "request_history_capacity");
        for (auto& item : agentRequests_)
            if (item.second.projectId == project
                && agentRequestStatus (item.second)["status"].toString() == "unresolved")
                return errResult (command, "unresolved_request: " + item.first);
        agentrequest::Record record;
        record.requestId = id;
        record.projectId = project;
        record.payloadDigest = agenttxn::digestOf (args["payload"]);
        record.status = "prepared";
        if (! persistAgentRequest (record)) return errResult (command, "request_ledger_write_failed");
        found = agentRequests_.emplace (id, record).first;
        return okResult (command, agentRequestStatus (found->second));
    }

    auto& record = found->second;
    if (record.projectId != project || (args.hasProperty ("payload")
        && record.payloadDigest != agenttxn::digestOf (args["payload"])))
        return errResult (command, "request_identity_conflict");
    auto status = agentRequestStatus (record);
    if (command == "get_agent_request") return okResult (command, status);
    if (command == "begin_agent_request")
    {
        if (! args.hasProperty ("payload")) return errResult (command, "payload_required");
        status.getDynamicObject()->setProperty ("replayed", true);
        status.getDynamicObject()->setProperty ("inProgress", record.status == "prepared" && ! record.loaded);
        return okResult (command, status);
    }
    if (command == "cancel_agent_request")
    {
        if (record.status == "prepared") record.status = "cancelled";
        else if (record.status == "unresolved")
        {
            if (record.preFingerprint.isEmpty() || txnFingerprint() != record.preFingerprint)
                return errResult (command, "unresolved_request: restore the recorded pre-state before cancelling");
            if (! removeAgentRecoveryRows (record))
                return errResult (command, "request_recovery_journal_write_failed_during_resolution");
            record.status = "rolled_back";
            record.nativeCommitted = false;
            if (unresolvedTxnIds_.contains (record.transactionId))
            {
                agenttxn::Record resolved;
                resolved.id = record.transactionId;
                resolved.status = agenttxn::statusRolledBack();
                appendTxnLedger (resolved);
                unresolvedTxnIds_.removeString (record.transactionId);
            }
        }
        if (! persistAgentRequest (record)) return errResult (command, "request_ledger_write_failed");
        return okResult (command, agentRequestStatus (record));
    }
    if (command == "undo_agent_request")
    {
        if (record.status == "undone") return okResult (command, agentRequestStatus (record, true));
        if (! (bool) status["undoable"])
            return errResult (command, "task_undo_not_owned: the task is not the current undoable unit");
        record.status = "unresolved";
        record.nativeCommitted = false;
        if (! persistAgentRequest (record)) return errResult (command, "request_ledger_write_failed_before_undo");
        auto result = cmdUndo (object ({}));
        if (! (bool) result["data"]) return errResult (command, "task_undo_failed");
        if (! removeAgentRecoveryRows (record))
            return errResult (command, "request_recovery_journal_write_failed_after_undo");
        record.status = "undone";
        if (! persistAgentRequest (record)) return errResult (command, "request_ledger_write_failed_after_undo");
        return okResult (command, agentRequestStatus (record));
    }
    if (! args.hasProperty ("payload")) return errResult (command, "payload_required");
    return applyAgentPatch (record, args);
}

var MoshOps::applyAgentPatch (agentrequest::Record& record, const var& args)
{
    const auto patchDigest = agenttxn::digestOf (args["commands"]);
    if (record.patchDigest.isNotEmpty() && record.patchDigest != patchDigest)
        return errResult ("apply_agent_patch", "patch_identity_conflict");
    if (record.status != "prepared")
        return okResult ("apply_agent_patch", agentRequestStatus (record, true));

    auto refusal = [this, &record] (const String& error)
    {
        record.status = "cancelled";
        if (! persistAgentRequest (record)) record.status = "unresolved";
        auto result = errResult ("apply_agent_patch", error);
        result.getDynamicObject()->setProperty ("data", agentRequestStatus (record));
        return result;
    };
    if (inBatch) return refusal ("transaction_already_open");
    if (args["epoch"].toString() != agentEpoch_ || ! args.hasProperty ("revision")
        || (juce::int64) args["revision"] != editRevision_)
        return refusal ("stale_agent_context");
    const auto commandsVar = args["commands"];
    const auto* commands = commandsVar.getArray();
    if (commands == nullptr || commands->isEmpty() || commands->size() > 6)
        return refusal ("invalid_bounded_patch");
    Array<var> manifest;
    for (int i = 0; i < commands->size(); ++i)
    {
        const auto& command = commands->getReference (i);
        if (! command.isObject() || ! command["args"].isObject()
            || ! agentrequest::allowedCommand (command["command"].toString()))
            return refusal ("unsupported_bounded_command");
        manifest.add (object ({ { "index", i }, { "requestId", String (i) },
                               { "command", command["command"] } }));
    }

    record.patchDigest = patchDigest;
    record.preFingerprint = txnFingerprint();
    record.epoch = agentEpoch_;
    record.transactionId = "request-" + agenttxn::digestOf (record.projectId + ":" + record.requestId);
    if (! persistAgentRequest (record)) return refusal ("request_ledger_write_failed");
    agentCrashPoint (eng, "before_apply", record.requestId);
    record.status = "applying";
    if (! persistAgentRequest (record)) return refusal ("request_ledger_write_failed");
    const auto transactionArgs = object ({ { "transactionId", record.transactionId },
                                          { "name", "agent bounded patch" }, { "commands", manifest },
                                          { "turn_id", record.requestId } });
    const auto begin = cmdBatchBegin (transactionArgs);
    if (! (bool) begin["ok"]) return refusal (begin["error"].toString());

    const ScopedValueSetter<String> ownedJournal (activeAgentJournalRequest_, record.requestId);
    bool failed = false;
    String failure;
    for (int i = 0; i < commands->size(); ++i)
    {
        const auto& command = commands->getReference (i);
        auto envelope = command.clone();
        envelope.getDynamicObject()->setProperty ("transaction", object ({
            { "transactionId", record.transactionId }, { "requestId", String (i) }, { "index", i } }));
        var result;
        if (! txnPreDispatch (envelope, result))
        {
            result = i == 1 && agentFaultArmed (eng, "MOSH_AGENT_FAIL_REQUEST", record.requestId)
                ? errResult (command["command"].toString(), "injected_failure: isolated second-command fault")
                : execute (envelope);
            txnPostDispatch (result);
        }
        record.results.add (result);
        if ((bool) result["ok"]) ++record.appliedCount;
        else { failed = true; failure = result["error"].toString(); }
        if (! persistAgentRequest (record)) { failed = true; failure = "request_ledger_write_failed"; }
        if (i == 0) agentCrashPoint (eng, "after_first_step", record.requestId);
        if (failed) break;
    }

    auto finish = failed ? cmdBatchRollback (transactionArgs) : cmdBatchEnd (transactionArgs);
    if (! failed && ! (bool) finish["ok"])
    {
        failed = true;
        failure = finish["error"].toString();
        finish = cmdBatchRollback (transactionArgs);
    }
    record.status = failed ? ((bool) finish["ok"] ? "rolled_back" : "unresolved") : "committed";
    record.nativeCommitted = ! failed;
    if (record.status == "rolled_back" && ! removeAgentRecoveryRows (record))
    {
        record.status = "unresolved";
        failure = "request_recovery_journal_write_failed_after_rollback";
    }
    syncUndoMirror();
    record.historyTxn = currentHistoryTxn();
    record.postFingerprint = txnFingerprint();
    if (! persistAgentRequest (record)) { record.status = "unresolved"; failed = true; failure = "request_ledger_write_failed_after_apply"; }
    if (! failed) agentCrashPoint (eng, "after_commit", record.requestId);
    auto response = failed ? errResult ("apply_agent_patch", failure) : okResult ("apply_agent_patch");
    response.getDynamicObject()->setProperty ("data", agentRequestStatus (record));
    return response;
}
}
