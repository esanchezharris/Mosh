"""Shared INJECTED lexicon for the bench's hermetic tests (never loads cmudict/g2p).

Not a test file itself — imported by mask_test.py / schema_test.py / metrics_test.py
so the frozen item golden and the policy tests pronounce identically forever.
"""
from phonology.core import Pronouncer

LEX = {
    "rent": [["R", "EH1", "N", "T"]], "cent": [["S", "EH1", "N", "T"]],
    "cold": [["K", "OW1", "L", "D"]], "gold": [["G", "OW1", "L", "D"]],
    "lit": [["L", "IH1", "T"]], "fit": [["F", "IH1", "T"]],
    "whole": [["HH", "OW1", "L"]], "sole": [["S", "OW1", "L"]],
    "pane": [["P", "EY1", "N"]], "rain": [["R", "EY1", "N"]],
    "train": [["T", "R", "EY1", "N"]], "chain": [["CH", "EY1", "N"]],
    "mind": [["M", "AY1", "N", "D"]], "lined": [["L", "AY1", "N", "D"]],
    "blind": [["B", "L", "AY1", "N", "D"]], "sign": [["S", "AY1", "N"]],
    "pain": [["P", "EY1", "N"]], "grind": [["G", "R", "AY1", "N", "D"]],
    "mine": [["M", "AY1", "N"]], "shine": [["SH", "AY1", "N"]],
    "line": [["L", "AY1", "N"]], "disguise": [["D", "IH0", "S", "G", "AY1", "Z"]],
    "rise": [["R", "AY1", "Z"]], "say": [["S", "EY1"]], "grey": [["G", "R", "EY1"]],
    "climb": [["K", "L", "AY1", "M"]],
    "suppertime": [["S", "AH1", "P", "ER0", "T", "AY2", "M"]],
    "echoes": [["EH1", "K", "OW2", "Z"]],
    "window": [["W", "IH1", "N", "D", "OW0"]],
    "basket": [["B", "AE1", "S", "K", "AH0", "T"]],
    "seven": [["S", "EH1", "V", "AH0", "N"]],
    "orange": [["AO1", "R", "AH0", "N", "JH"]],
    "pristine": [["P", "R", "IH0", "S", "T", "IY1", "N"]],
    "scene": [["S", "IY1", "N"]],
    "guap": [["G", "W", "AA1", "P"]], "drip": [["D", "R", "IH1", "P"]],
    "love": [["L", "AH1", "V"]], "move": [["M", "UW1", "V"]],
    "dove": [["D", "AH1", "V"]],
}


def make_pron() -> Pronouncer:
    return Pronouncer(lexicon=LEX, g2p=lambda w: None)
