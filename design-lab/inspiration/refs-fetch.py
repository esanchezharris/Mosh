#!/usr/bin/env python3
"""Fetch X post text + media thumbnails via fxtwitter for the inspiration pass."""
import json, time, urllib.request, os, sys

POSTS = [
    ("RLanceMartin","2064397389189071163"),("ideogram_ai","2062956373957292281"),
    ("marioecg","2064035914666725807"),("marioecg","2063669111461490753"),
    ("marioecg","2062204832740786335"),("marioecg","2054244393696272484"),
    ("marioecg","2053886239418569211"),("marioecg","2053482826352513265"),
    ("marioecg","2053159309639569651"),("marioecg","2052801630358372486"),
    ("marioecg","2052433438976954541"),("marioecg","2050635705421037619"),
    ("marioecg","2046283591383163199"),
    ("obtainer","2062192116009164973"),
    ("M_Pierini","2054879864990167396"),("M_Pierini","2062127361961644484"),
    ("BlousonRouge","2063843553252458864"),("youtoy","1966682917989740600"),
    ("_NatSarkissian","1882311808893276343"),("IOivm","1988138409664377169"),
    ("gorillasu","1501499940714987526"),("gorillasu","1437801543441473549"),
    ("Foundation_HWF","2054881404421304419"),("techartist_","2064370875571540421"),
    ("Oluwaphilemon1","2064072963264012480"),("vitekvisuals","2064402158024364528"),
    ("genmediaclub","2064271555576918432"),("Goldilocks3bkm","2064185925605954018"),
    ("junkiyoshi","2064306046718595125"),("junkiyoshi","2063229799347494957"),
    ("MCHX17","2064249943561208087"),("MCHX17","2064073433684529549"),
    ("MCHX17","2063940798261895267"),("MCHX17","2064430456443998575"),
    ("MCHX17","1914206386168135804"),
    ("verse_works","2064070598486077592"),("graceb_art","2063660988423958892"),
    ("ericaofanderson","2064410057157071245"),
    ("sabosugi","2063898498530222293"),("sabosugi","2063714417464738293"),
    ("specoolar","1976772832635007117"),("einsteinekeine","2064074727182729716"),
    ("m_hakozaki","1640521336870293505"),("Waterflowing0","1703416636168872433"),
    ("wtshm","1792508896122425409"),("TatsuyaBot","2064190506838749431"),
    ("xeriesjame_art","2064322487010394121"),("eatora22","1769680146242629635"),
    ("pattlas_app","2063944853386596621"),("Sko_hr","2064279800601350245"),
    ("mariaakrutsko","2064420744298164434"),("p1xelfool","2064372335163982165"),
    ("Kowaii114","2064277855597711630"),("riomadeit","1878556039676666024"),
    ("KaibaRH","2064390442368536656"),("xbh_artist","2063996174617735455"),
    ("artofallan","2062789738873163849"),
    ("mjmurdoc","2062742203928301898"),("mjmurdoc","2061314622498775052"),
    ("mjmurdoc","2057329742521778675"),("mjmurdoc","2055875624334762164"),
    ("Guy_G1bby","2061604525522272602"),("bengilch","2059605343622074675"),
    ("Jaenam97","1988978849351405720"),("Jaenam97","1988652695490838862"),
    ("Jaenam97","1986765669421961502"),
    ("tinybugbot","1984637480277328092"),("RohanCreates","1979191766893891969"),
    ("swzydzn","1978169870098244045"),("Nicolas_Sassoon","1978131063932092861"),
    ("ZloNoNameSov","1966994701913125000"),("poetengineer__","1966736628497502219"),
    ("echoGFX_","1966607754857963992"),("Macbaconai","1966573991335719044"),
    ("SesoHQ","1965152599294050391"),("nam_mac","1954308841983877234"),
    ("palekirill","1932830196131917962"),("enma__0312","1930604207528362378"),
    ("chiu_hans","1895710256103387440"),("HAL09999","1895514600478818527"),
    ("hours","1893697564035186772"),("blankensmithing","1884523743428378821"),
    ("_alphanium_","2063995177673621958"),("100000000xxxxxx","2064324437147545752"),
    ("CollectUI","2064165589103559121"),
    ("hive_echo","2064270168294080581"),("hive_echo","2064244474046452202"),
    ("hive_echo","2064220267858251832"),
    ("yamnor","2064165587014529236"),("DOT4_studio","2064331979256902042"),
    ("losephntm","2064281762616967418"),("m7kenji","2064223159164002518"),
    ("itscamacon","2064013369850339530"),("berto_bau","2064172271128748205"),
    ("lukasspitter","2064272440599998639"),("314o_de_315","2064301944873853068"),
    ("hesherVFX","2064344448134512904"),
    ("bmaybe838","2064289713842966885"),("bmaybe838","2063979709516730383"),
    ("jbaker_graphics","2064383581103821025"),("GaloAndStuff","2064348862865637787"),
    ("kaolti","2064334491762532421"),("DaniyarUI","2064314207680725060"),
]

OUT = "/private/tmp/mosh-inspo"
os.makedirs(OUT, exist_ok=True)
manifest = []
UA = {"User-Agent": "Mozilla/5.0 (design-lab inspiration pass)"}

def get(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout).read()

ok = fail = 0
for user, sid in POSTS:
    entry = {"author": user, "id": sid, "url": f"https://x.com/{user}/status/{sid}"}
    try:
        d = json.loads(get(f"https://api.fxtwitter.com/{user}/status/{sid}"))
        t = d.get("tweet") or {}
        entry["text"] = (t.get("text") or "").replace("\n", " ")[:300]
        entry["likes"] = t.get("likes")
        m = t.get("media") or {}
        media_url, kind = None, "none"
        if m.get("videos"):
            media_url, kind = m["videos"][0].get("thumbnail_url"), "video"
        elif m.get("photos"):
            u = m["photos"][0].get("url")
            media_url, kind = (u + ("&" if "?" in u else "?") + "name=small"), "photo"
        entry["kind"] = kind
        if media_url:
            img = get(media_url, timeout=20)
            fn = f"{OUT}/{user}__{sid}.jpg"
            open(fn, "wb").write(img)
            entry["file"] = fn
        ok += 1
    except Exception as e:
        entry["error"] = str(e)[:80]
        fail += 1
    manifest.append(entry)
    time.sleep(0.35)

json.dump(manifest, open(f"{OUT}/manifest.json", "w"), indent=1)
imgs = [e for e in manifest if e.get("file")]
print(f"fetched {ok} ok, {fail} failed, {len(imgs)} images saved")
for e in manifest:
    if e.get("error"):
        print("  FAIL", e["author"], e["id"], e["error"])
