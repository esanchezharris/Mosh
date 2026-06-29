#!/usr/bin/env python3
"""Rage / underground register seed (Bar IQ B) — a curated VOCABULARY in the Opium / rage
lane (Ken Carson, nettspend, Fakemink, twentythree & adjacent): the slang, ad-libs, and raw
register these artists trade in.

This is a word list — individual slang words / ad-libs / profanity are FACTS, not protected
expression (a dictionary, not a lyric corpus). No lines are stored or reproduced; reference
artists only informed *which words/register* to support. The producer is the editor: prune
by ear, add their own via /vocab add. Registers map to the palette's tags
(slang | adlib | profanity); clean mode filters `profanity`.

Deliberately omitted: slurs. Those are the artist's own editorial call (add by ear), not
something the tool seeds. Brand names appear as plain nouns (vocabulary, not endorsement).
"""

# (word, register). Deduped by the palette on load; overlaps with the generic seed are fine.
RAGE_WORDS = [
    # ── ad-libs (the scene's percussive vocal stabs) ──────────────────────────────
    ("yuh", "adlib"), ("uh", "adlib"), ("ayy", "adlib"), ("ay", "adlib"), ("huh", "adlib"),
    ("woah", "adlib"), ("woo", "adlib"), ("grr", "adlib"), ("brra", "adlib"), ("blrrd", "adlib"),
    ("skrt", "adlib"), ("skrrt", "adlib"), ("slatt", "adlib"), ("boom", "adlib"), ("what", "adlib"),
    ("ok", "adlib"), ("hey", "adlib"), ("ugh", "adlib"), ("mmm", "adlib"), ("ooh", "adlib"),
    ("brr", "adlib"), ("yeah", "adlib"), ("nah", "adlib"), ("yup", "adlib"), ("rah", "adlib"),
    ("pow", "adlib"), ("vroom", "adlib"), ("bah", "adlib"),

    # ── slang: energy / scene ─────────────────────────────────────────────────────
    ("rage", "slang"), ("mosh", "slang"), ("moshpit", "slang"), ("geeked", "slang"), ("geekin", "slang"),
    ("tweakin", "slang"), ("spazz", "slang"), ("spazzin", "slang"), ("rizz", "slang"), ("swag", "slang"),
    ("lit", "slang"), ("turnt", "slang"), ("wildin", "slang"), ("buggin", "slang"), ("trippin", "slang"),
    ("vibe", "slang"), ("vibes", "slang"), ("aura", "slang"), ("sigma", "slang"), ("demon", "slang"),
    ("motion", "slang"), ("pressure", "slang"), ("glo", "slang"),

    # ── slang: drip / flex / money ────────────────────────────────────────────────
    ("drip", "slang"), ("drippy", "slang"), ("drippin", "slang"), ("racks", "slang"), ("bands", "slang"),
    ("bag", "slang"), ("guap", "slang"), ("sauce", "slang"), ("saucy", "slang"), ("iced", "slang"),
    ("froze", "slang"), ("frozen", "slang"), ("wrist", "slang"), ("chain", "slang"), ("diamonds", "slang"),
    ("vvs", "slang"), ("designer", "slang"), ("foreign", "slang"), ("splurge", "slang"), ("check", "slang"),
    ("millions", "slang"), ("rich", "slang"), ("wealthy", "slang"), ("stunt", "slang"), ("stuntin", "slang"),
    ("flex", "slang"), ("flexin", "slang"), ("flexed", "slang"), ("trill", "slang"), ("amiri", "slang"),
    ("sprayground", "slang"), ("lambo", "slang"), ("rari", "slang"), ("benz", "slang"), ("wraith", "slang"),
    ("mansion", "slang"), ("crib", "slang"),

    # ── slang: motion / cars ──────────────────────────────────────────────────────
    ("whip", "slang"), ("swerve", "slang"), ("slide", "slang"), ("slidin", "slang"), ("spinnin", "slang"),

    # ── slang: street / trap (genre vocabulary; tagged slang, not profanity) ───────
    ("opp", "slang"), ("opps", "slang"), ("cap", "slang"), ("plug", "slang"), ("pack", "slang"),
    ("loud", "slang"), ("gas", "slang"), ("zip", "slang"), ("bando", "slang"), ("trap", "slang"),
    ("trappin", "slang"), ("glizzy", "slang"), ("blicky", "slang"), ("stick", "slang"), ("draco", "slang"),
    ("switch", "slang"), ("chopper", "slang"), ("choppa", "slang"), ("extendo", "slang"), ("clip", "slang"),
    ("beam", "slang"), ("scope", "slang"), ("percs", "slang"), ("perc", "slang"), ("lean", "slang"),
    ("mud", "slang"), ("drank", "slang"), ("addy", "slang"), ("juug", "slang"), ("juggin", "slang"),
    ("finesse", "slang"), ("lick", "slang"), ("score", "slang"), ("broke", "slang"), ("smoke", "slang"),
    ("beef", "slang"), ("shooter", "slang"), ("gang", "slang"), ("gangin", "slang"), ("set", "slang"),
    ("hood", "slang"), ("block", "slang"), ("clique", "slang"), ("mob", "slang"), ("grind", "slang"),
    ("hustle", "slang"),

    # ── profanity (standard set — NO slurs; tagged so clean mode filters them) ──────
    ("fuck", "profanity"), ("fuckin", "profanity"), ("shit", "profanity"), ("shitty", "profanity"),
    ("bitch", "profanity"), ("ass", "profanity"), ("damn", "profanity"), ("hell", "profanity"),
    ("bullshit", "profanity"), ("dumbass", "profanity"), ("dick", "profanity"), ("hoe", "profanity"),
    ("piss", "profanity"),
]
