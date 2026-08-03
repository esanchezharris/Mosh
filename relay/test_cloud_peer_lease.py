"""Contract checks for the deployed Postgres relay's peer-expiry migration.

These checks do not pretend to execute Postgres. They keep the checked-in cloud
backend aligned with the executable local relay tests: expiry must run before
capacity/roster decisions, stale locks must be released, and membership-gated
blob URLs must reject an expired peer.
"""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260802080000_mp_peer_lease.sql"


def _sql():
    assert MIGRATION.is_file(), "the live cloud backend needs an additive migration"
    return MIGRATION.read_text(encoding="utf-8")


def _function(sql, qualified_name):
    match = re.search(
        rf"create or replace function\s+{re.escape(qualified_name)}\b.*?\$\$(.*?)\$\$;",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    assert match, f"missing replacement for {qualified_name}"
    return match.group(1).lower()


def test_cloud_expiry_releases_locks_before_peers():
    body = _function(_sql(), "mp.expire_stale_peers")
    assert "interval '90 seconds'" in body
    assert body.index("delete from mp.locks") < body.index("delete from mp.peers")
    assert "p.last_seen" in body


def test_cloud_join_expires_stale_slots_before_capacity_check():
    body = _function(_sql(), "public.mp_join_room")
    assert body.index("mp.expire_stale_peers") < body.index("select count(*)")


def test_cloud_events_expire_then_refresh_then_build_roster():
    body = _function(_sql(), "public.mp_events")
    assert body.index("mp.expire_stale_peers") < body.index("update mp.peers")
    assert body.index("update mp.peers") < body.index("into v_peers")
    assert "not_a_member" in body


def test_cloud_publish_and_blob_membership_reject_expired_peers():
    sql = _sql()
    publish = _function(sql, "public.mp_publish")
    member = _function(sql, "public.mp_is_member")
    assert publish.index("mp.expire_stale_peers") < publish.index("insert into mp.messages")
    assert "not_a_member" in publish
    assert "last_seen > now() - interval '90 seconds'" in member


def test_cloud_gc_uses_the_same_peer_expiry_helper():
    sweep = _function(_sql(), "mp.sweep")
    assert "mp.expire_stale_peers" in sweep
    assert re.search(r"select\s+code\s+from\s+mp\.rooms\s+for\s+update", sweep)
