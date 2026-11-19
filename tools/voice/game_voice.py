"""game-voice: lines.csv -> TTS (voxcpm2 | moss | gemini) -> QC -> loudness -> visemes -> Unreal CSV.

Run through game-voice.cmd (it points at the portable venv in bin/voice). One file, no framework.
Cache: out/<engine>/<id>.wav + .json sidecar holding the input hash; unchanged lines are skipped.
Secrets: the Gemini step reads only os.environ["GOOGLE_AI_API_KEY"] and never prints it.
"""
import argparse, csv, hashlib, json, os, re, shutil, subprocess, sys, time, unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = HERE.parents[1]
BIN = STUDIO / "bin" / "voice"
MODELS = BIN / "models"
FFMPEG = Path(os.environ.get("FFMPEG", STUDIO / "bin" / "ffmpeg.exe"))  # bin/ is git-ignored; or set FFMPEG
FONT_DIR = os.environ.get("FONT_DIR", r"C:\Windows\Fonts")  # drawtext finds arial.ttf here (Windows default)
RHUBARB = BIN / "rhubarb" / "rhubarb.exe"
WORK = Path(os.environ.get("GAME_VOICE_WORK", Path.cwd() / "voice-work"))  # per-game: lines.csv, voices.json, names.json, out/
os.environ.setdefault("HF_HOME", str(BIN / "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")  # models are local; nothing may phone home mid-run
LUFS_TARGET, PEAK_DB = -17.0, -1.5
HE_NIKUD = re.compile(r"[֑-ׇ]")

# emotion tag -> style phrase. Unknown tags fall through unchanged.
EMOTION = {
    "whisper": "whispering softly, low and breathy",
    "quiet": "speaking quietly and low",
    "anger": "angry, hard and forceful",
    "cold": "cold, controlled, quietly menacing",
    "fear": "frightened, voice held down, tense",
    "grief": "raw grief, voice cracking",
    "effort": "shouting with effort in a fight, loud and strained",
    "humour": "wry, with a smile in the voice",
    "calm": "calm and steady",
    "eager": "eager and bright, quick",
    "tender": "tender and tired, gentle",
    "bitter": "bitter and resentful",
    "recalling": "slow, recalling, thoughtful",
    "grim": "grim and low",
    "practical": "plain and practical",
    "sardonic": "sardonic, dry",
    "mocking": "mocking, barking an order",
    "defiance": "defiant, loud",
}


# ---------------------------------------------------------------- manifest

def read_csv(p):
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(p, rows, fields):
    with open(p, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


LINE_FIELDS = ["id", "lang", "speaker", "text", "text_prepared", "emotion", "direction", "space", "status", "take"]


def load_json(name, default):
    p = WORK / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def sha(*parts):
    h = hashlib.sha256()
    for x in parts:
        h.update(str(x).encode("utf-8") + b"\x00")
    return h.hexdigest()[:16]


def select(rows, ids, speaker=None, lang=None):
    out = []
    for r in rows:
        if ids and not any(re.fullmatch(p.replace("*", ".*"), r["id"]) for p in ids):
            continue
        if speaker and r["speaker"] != speaker:
            continue
        if lang and r["lang"] != lang:
            continue
        out.append(r)
    return out


def style_phrase(row):
    tags = [t.strip() for t in re.split(r"[,;]", row.get("emotion", "")) if t.strip()]
    ph = [EMOTION.get(t, t) for t in tags]
    if row.get("direction"):
        ph.append(row["direction"])
    return ", ".join(ph)


# ---------------------------------------------------------------- text prep

def strip_nikud(s):
    return HE_NIKUD.sub("", s)


def apply_lexicon(text, lang, names):
    """names.json: {"Zed": {"he": "זֶד", "en": "zed"}}; longest key first."""
    for k in sorted(names, key=len, reverse=True):
        v = names[k].get(lang)
        if v:
            text = re.sub(rf"\b{re.escape(k)}\b", v, text) if lang == "en" else text.replace(k, v)
    return text


_phonikud = None


def load_phonikud():
    """phonikud_onnx fetches its tokenizer from the Hub; point it at the local dictabert copy (offline)."""
    import phonikud_onnx.model as pm
    from tokenizers import Tokenizer
    pm.Tokenizer = type("T", (), {"from_pretrained": staticmethod(lambda _n: Tokenizer.from_file(str(MODELS / "dictabert" / "tokenizer.json")))})
    from phonikud_onnx import Phonikud
    return Phonikud(str(MODELS / "phonikud" / "phonikud-1.0.int8.onnx"))


def repoint(row):
    """Strip any niqqud, then let Phonikud add it: the path real game text takes."""
    global _phonikud
    if _phonikud is None:
        _phonikud = load_phonikud()
    return _phonikud.add_diacritics(strip_nikud(row["text"])).replace("|", "")  # "|" is Phonikud's morpheme marker; engines would read it


def prep_text(row, names):
    t = row["text"].strip()
    t = apply_lexicon(t, row["lang"], names)
    if row["lang"] == "he" and len(HE_NIKUD.findall(t)) < max(3, len(t) // 8):
        global _phonikud
        if _phonikud is None:
            _phonikud = load_phonikud()
        t = _phonikud.add_diacritics(t)
    return t


# ---------------------------------------------------------------- audio helpers

def read_wav(p):
    import soundfile as sf
    a, sr = sf.read(str(p), dtype="float32", always_2d=True)
    return a.mean(axis=1), sr


def write_wav(p, a, sr):
    import soundfile as sf
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(p), a, sr, subtype="PCM_16")


def pcm16k(path):
    """16 kHz mono float32 via ffmpeg: faster_whisper's own decoder (PyAV) fails to open files in this venv."""
    import numpy as np
    r = subprocess.run([str(FFMPEG), "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype="<f4")


def lufs_of(path):
    """Integrated loudness via ffmpeg ebur128 (scipy/pyloudnorm are blocked by the machine's app-control policy)."""
    r = subprocess.run([str(FFMPEG), "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return float(m[-1]) if m else None


def loudnorm_file(path):
    """Bring the file to LUFS_TARGET with a limiter at PEAK_DB, re-measuring (peaky clips lose loudness to the limiter, so one pass left them 3-5 LU low). Returns final LUFS."""
    cur = lufs_of(path)
    for _ in range(4):
        if cur is None or cur < -70 or abs(cur - LUFS_TARGET) < 0.3:
            break
        tmp = Path(str(path) + ".ln.wav")
        subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(path), "-af",
                        f"volume={LUFS_TARGET - cur:.2f}dB,alimiter=limit={10 ** (PEAK_DB / 20):.3f}:attack=3:release=60:level=disabled",
                        "-c:a", "pcm_s16le", str(tmp)], check=True)
        tmp.replace(path)
        cur = lufs_of(path)
    return cur


def trim_silence(a, sr, thr=0.01, pad=0.12):
    import numpy as np
    idx = np.where(np.abs(a) > thr)[0]
    if len(idx) == 0:
        return a
    return a[max(0, idx[0] - int(pad * sr)): idx[-1] + int(pad * sr)]


SPACES = {  # shortcut: aecho approximations (no impulse responses downloaded); swap for afir + IR files when wanted
    "stone": "aecho=0.9:0.88:55|95|150:0.22|0.14|0.08,lowpass=f=9000",
    "hall": "aecho=0.9:0.85:90|160|260|380:0.3|0.22|0.15|0.1,lowpass=f=8000",
    "cellar": "aecho=0.9:0.9:35|70:0.3|0.2,highpass=f=100",
}


def reverb(wav, space):
    if space not in SPACES:
        return
    tmp = Path(str(wav) + ".rv.wav")
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(wav), "-af", SPACES[space], "-ar", "48000", str(tmp)], check=True)
    tmp.replace(wav)


# ---------------------------------------------------------------- engines

class VoxCPM2:
    name = "voxcpm2"
    version = "VoxCPM2-2.0.3"

    def __init__(self):
        from voxcpm import VoxCPM
        self.m = VoxCPM.from_pretrained(str(MODELS / "voxcpm2"), load_denoiser=False, optimize=False)
        self.sr = self.m.tts_model.sample_rate

    def say(self, row, text, style, ref, voice):
        # ref given -> controllable cloning of the frozen anchor; else voice design from the description
        if ref:
            t = f"({style}){text}" if style else text
            return self.m.generate(text=t, reference_wav_path=str(ref), cfg_value=2.0, inference_timesteps=10), self.sr
        desc = ", ".join(x for x in [voice.get("gender", ""), voice.get("short") or voice.get("desc_" + row["lang"]) or voice.get("desc_en", ""), style] if x)
        return self.m.generate(text=f"({desc}){text}", cfg_value=2.0, inference_timesteps=10), self.sr


class Moss:
    name = "moss"
    version = "MOSS-TTS-Local-Transformer-v1.5"
    LANGS = {"he": "Hebrew", "en": "English"}

    def __init__(self):
        import torch
        from transformers import AutoModel, AutoProcessor
        torch.backends.cuda.enable_cudnn_sdp(False)
        self.torch = torch
        p = str(MODELS / "moss")
        self.proc = AutoProcessor.from_pretrained(p, trust_remote_code=True)  # repo code reviewed first; see DOWNLOADS.md
        self.proc.audio_tokenizer = self.proc.audio_tokenizer.to("cuda")
        self.m = AutoModel.from_pretrained(p, trust_remote_code=True, attn_implementation="sdpa", torch_dtype=torch.bfloat16)
        self.m = self.m.to("cuda").eval()
        self.sr = 48000

    def say(self, row, text, style, ref, voice):
        t = self.torch
        kw = {"text": text, "language": self.LANGS[row["lang"]]}
        if ref:
            kw["reference"] = [str(ref)]
        msg = self.proc.build_user_message(**kw)
        b = self.proc([[msg]], mode="generation")
        with t.no_grad():
            out = self.m.generate(input_ids=b["input_ids"].to("cuda"), attention_mask=b["attention_mask"].to("cuda"),
                                  max_new_tokens=2048, do_sample=True, audio_temperature=1.7, audio_top_p=0.8, audio_top_k=25,
                                  audio_repetition_penalty=1.0)
        for m in self.proc.decode(out):
            if m is not None:
                a = m.audio_codes_list[0].float().cpu().numpy()
                return a.mean(axis=0), self.sr
        raise RuntimeError("moss returned no audio")


class Lazy:
    """Build the engine on first use; name/version are known without loading."""
    def __init__(self, cls):
        self.cls, self.obj, self.name, self.version = cls, None, cls.name, cls.version

    def say(self, *a):
        self.obj = self.obj or self.cls()
        return self.obj.say(*a)


class Gemini:
    name = "gemini"
    DEFAULT_MODEL = "gemini-3.8-flash-tts"  # id from ai.google.dev speech-generation docs 2026-11-17; override with GEMINI_TTS_MODEL
    PRICE_IN, PRICE_OUT = 0.50, 9.00  # USD per 1M tokens (text in, audio out) to 2026-12-31; both double on 2027-01-01

    def __init__(self):
        self.key = os.environ.get("GOOGLE_AI_API_KEY")
        if not self.key:
            sys.exit("GOOGLE_AI_API_KEY is not set. Run through tools\\secrets\\with-secret.ps1 -Name GOOGLE_AI_API_KEY -Run \"...\"")
        self.model = os.environ.get("GEMINI_TTS_MODEL", self.DEFAULT_MODEL)
        self.version = self.model
        self.sr = 24000

    def say(self, row, text, style, ref, voice):
        # Gemini 3.8 TTS: text is a verbatim transcript, delivery goes in speech_metadata.style (docs: /docs/speech-generation)
        import base64, io, urllib.request, urllib.error
        import soundfile as sf
        st = ", ".join(x for x in [style, voice.get("short")] if x)
        ann = [{"type": "speech_metadata", "style": st}] if st else []
        body = {"model": self.model,
                "input": [{"type": "user_input", "content": [{"type": "text", "text": text, "annotations": ann}]}],
                "response_format": {"type": "audio"},
                "generation_config": {"speech_config": [{"voice": voice.get("gemini_voice", "Charon")}]}}
        req = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/interactions",
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": self.key})
        try:
            d = json.load(urllib.request.urlopen(req, timeout=120))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"gemini HTTP {e.code}: {e.read().decode()[:300].replace(self.key, '***')}") from None
        blocks = [c for st_ in d.get("steps", []) if st_.get("type") == "model_output" for c in st_.get("content", []) if c.get("type") == "audio"]
        a, sr = sf.read(io.BytesIO(base64.b64decode(blocks[-1]["data"])), dtype="float32", always_2d=True)
        u = d.get("usage", {})
        self.last_usage = dict(usage_raw=u, **self.cost_of(u, len(a) / sr))  # usage field names are undocumented: raw kept for audit
        return a.mean(axis=1), sr

    @classmethod
    def cost_of(cls, u, secs):
        tin = u.get("total_input_tokens", 0) or u.get("input_tokens", 0) or 0
        tout = u.get("total_output_tokens", 0) or u.get("output_tokens", 0) or round(secs * 25)  # docs: 25 audio tokens per second
        return dict(tokens_in=tin, tokens_out=tout, usd=round((tin * cls.PRICE_IN + tout * cls.PRICE_OUT) / 1e6, 6))


ENGINES = {"voxcpm2": VoxCPM2, "moss": Moss, "gemini": Gemini}


# ---------------------------------------------------------------- commands

def out_dir(engine):
    return WORK / "out" / engine


def anchor_for(voices, row):
    v = voices.get(row["speaker"], {})
    a = v.get("anchor_" + row["lang"]) or v.get("anchor")
    return (WORK / a) if a else None


def cmd_import_script(a):
    """Parse a markdown voice script (sections "## E1. Name" with a **Voice:** line and numbered lines "1. (tag) text") into lines.csv + voices.json skeleton."""
    md = Path(a.script).read_text(encoding="utf-8")
    rows, voices = [], load_json("voices.json", {})
    for blk in re.split(r"\n## ", md)[1:]:
        m = re.match(r"([EF]\d)\. (.+)", blk)
        if not m:
            continue
        code, name = m.group(1).lower(), m.group(2).strip()
        slug = re.sub(r"[^a-z]+", "", name.lower().split(",")[0].split()[-1])
        spk = f"{code}_{slug}"
        vd = re.search(r"\*\*Voice:\*\* (.+)", blk).group(1).strip()
        v = voices.setdefault(spk, {})
        v.setdefault("name", name)
        v.setdefault("desc_en", vd.rstrip("."))
        for n, tag, text in re.findall(r"^(\d)\. \(([^)]*)\) (.+)$", blk, re.M):
            text = text.strip().strip('"').strip()
            lang = "he" if re.search(r"[֐-׿]", text) else "en"
            text = text.replace("*", "")
            rows.append(dict(id=f"{spk}_{n}_{lang}", lang=lang, speaker=spk, text=text, text_prepared="", emotion=tag,
                             direction="", space="", status="new", take="1"))
    WORK.mkdir(parents=True, exist_ok=True)
    write_csv(WORK / "lines.csv", rows, LINE_FIELDS)
    (WORK / "voices.json").write_text(json.dumps(voices, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(rows)} lines, {len(voices)} voices -> {WORK}")


def free_gpu():
    import gc
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass


def generate(eng, rows, voices, names, od, designing=False, tag=""):
    """Returns list of (row, wav path, seconds, cached)."""
    res = []
    for r in rows:
        v = voices.get(r["speaker"], {})
        ref = None if (designing or eng.name == "gemini") else anchor_for(voices, r)
        text = r["text_prepared"] or prep_text(r, names)
        style = style_phrase(r)
        h = sha(eng.name, eng.version, text, style, ref.read_bytes()[:4096].hex() if ref else "", r["take"], v.get("desc_en", ""), v.get("short", ""), tag)
        wav, meta = od / f"{r['id']}{tag}.wav", od / f"{r['id']}{tag}.json"
        if wav.exists() and meta.exists() and json.loads(meta.read_text())["hash"] == h:
            res.append((r, wav, json.loads(meta.read_text())["seconds"], True))
            continue
        t0 = time.time()
        audio, sr = eng.say(r, text, style, ref, v)
        dt = time.time() - t0
        import numpy as np
        audio = np.asarray(audio, dtype="float32").squeeze()
        audio = trim_silence(audio, sr)
        write_wav(wav, audio, sr)
        if r.get("space"):
            reverb(wav, r["space"])
        lufs = loudnorm_file(wav)  # after reverb, so the room does not change the level
        meta.write_text(json.dumps({"hash": h, "engine": eng.name, "version": eng.version, "seconds": round(dt, 2),
                                    "dur": round(len(audio) / sr, 2), "lufs": lufs, "text": text, "style": style,
                                    **getattr(eng, "last_usage", {})}), encoding="utf-8")
        print(f"  {eng.name} {r['id']}{tag}: {dt:.1f}s gen -> {len(audio)/sr:.1f}s audio", flush=True)
        res.append((r, wav, dt, False))
    return res


def cmd_gen(a):
    rows, voices, names = read_csv(WORK / "lines.csv"), load_json("voices.json", {}), load_json("names.json", {})
    rows = select(rows, a.ids, a.speaker, a.lang)
    if a.engine == "gemini" and not a.confirmed:
        sys.exit("gemini is a paid call: pass --confirmed only after the integrator says go")
    if a.repoint:
        rows = [dict(r, text_prepared=repoint(r)) if r["lang"] == "he" else r for r in rows]
    eng = ENGINES[a.engine]()
    if not a.plain_only:
        generate(eng, rows, voices, names, out_dir(a.engine))
    if a.plain or a.plain_only:  # A/B: Hebrew without nikud (only he rows differ); lands in out/<engine>-plain
        he = [dict(r, text_prepared=strip_nikud(r["text"])) for r in rows if r["lang"] == "he"]
        generate(eng, he, voices, names, out_dir(a.engine + "-plain"))


def cmd_design(a):
    """Voice design: N takes of the anchor line per speaker+lang, QC, freeze the best as the reference clip."""
    rows, voices, names = read_csv(WORK / "lines.csv"), load_json("voices.json", {}), load_json("names.json", {})
    anchors = {}
    for r in select(rows, a.ids, a.speaker, a.lang):
        anchors.setdefault(r["speaker"], r)  # first line (Hebrew, calm) is the design line; one timbre per lead for both languages
    eng = Lazy(VoxCPM2)  # cached takes need no model load
    dd = WORK / "out" / "design"
    cands = {}
    for spk, r in anchors.items():
        for k in range(1, a.takes + 1):
            res = generate(eng, [r], voices, names, dd, designing=True, tag=f"_t{k}")
            cands.setdefault(spk, []).append((r, res[0][1]))
    eng.obj = None
    free_gpu()
    asr = Asr()
    for spk, lst in cands.items():
        scored = sorted(((asr.score(w, r["text"], r["lang"]), w) for r, w in lst), key=lambda x: x[0])
        best = scored[0]
        dst = WORK / "voices" / f"{spk}.wav"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(best[1], dst)
        for k in [k for k in voices[spk] if k.startswith("anchor_")]:
            del voices[spk][k]  # drop any per-language anchors from older runs
        voices[spk]["anchor"] = f"voices/{spk}.wav"
        voices[spk]["anchor_err"] = round(best[0], 3)
        print(f"froze {spk}: err {best[0]:.2f} (takes: {[round(s[0],2) for s in scored]})")
    (WORK / "voices.json").write_text(json.dumps(voices, ensure_ascii=False, indent=1), encoding="utf-8")


class Asr:
    """ivrit-ai Whisper turbo (CT2) for both languages; the English stock model was not approved for download.
    Hebrew is scored by CER (Whisper writes plene spelling, so WER over-penalises); English by WER."""

    def __init__(self):
        from faster_whisper import WhisperModel
        self.WM, self.dev = WhisperModel, "cuda"
        self.m = self._load("cuda", "float16")

    def _load(self, dev, ct):
        try:
            return self.WM(str(MODELS / "whisper-he"), device=dev, compute_type=ct)
        except Exception:
            self.dev = "cpu"
            return self.WM(str(MODELS / "whisper-he"), device="cpu", compute_type="int8")

    @staticmethod
    def norm(s):
        s = HE_NIKUD.sub("", s)
        s = unicodedata.normalize("NFKC", s).lower().replace("-", " ").replace("־", " ")
        return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", s)).strip()

    def transcribe(self, wav, lang):
        try:
            segs, _ = self.m.transcribe(pcm16k(wav), language=lang, beam_size=5)
            return " ".join(s.text for s in segs)
        except Exception:  # CUDA libs missing at run time -> CPU
            if self.dev == "cpu":
                raise
            self.dev = "cpu"
            self.m = self.WM(str(MODELS / "whisper-he"), device="cpu", compute_type="int8")
            return self.transcribe(wav, lang)

    def errs(self, wav, ref, lang):
        """(wer, cer) after stripping nikud and punctuation."""
        import jiwer
        r, h = self.norm(ref), self.norm(self.transcribe(wav, lang))
        return (jiwer.wer(r, h), jiwer.cer(r, h)) if h else (1.0, 1.0)

    def score(self, wav, ref, lang):
        w, c = self.errs(wav, ref, lang)
        return c if lang == "he" else w


def cmd_qc(a):
    rows = select(read_csv(WORK / "lines.csv"), a.ids, None, None)
    asr = Asr()
    out = []
    for eng in a.engines:
        for r in rows:
            w, m = out_dir(eng) / f"{r['id']}.wav", out_dir(eng) / f"{r['id']}.json"
            if not w.exists():
                continue
            meta = json.loads(m.read_text())
            wer, cer = asr.errs(w, r["text"], r["lang"])
            audio, sr = read_wav(w)
            lufs = lufs_of(w)
            pk = float(abs(audio).max())
            out.append(dict(engine=eng, id=r["id"], lang=r["lang"], speaker=r["speaker"], wer=round(wer, 3), cer=round(cer, 3), lufs=round(lufs or 0, 1),
                            peak_db=round(20 * __import__("math").log10(max(pk, 1e-9)), 1), dur=meta["dur"], gen_s=meta["seconds"],
                            ok=(cer <= 0.12 if r["lang"] == "he" else wer <= 0.10) and abs((lufs or -17) - LUFS_TARGET) < 1.5 and pk < 0.99))
            print(out[-1], flush=True)
    write_csv(WORK / "qc.csv", out, list(out[0]) if out else ["engine"])


def cmd_visemes(a):
    if not RHUBARB.exists():
        sys.exit("rhubarb not installed")
    for w in sorted((out_dir(a.engine)).glob("*.wav")):
        dst = w.with_suffix(".visemes.json")
        lang = "he" if w.stem.endswith("_he") else "en"
        # default recogniser is English-only; phonetic is language independent (lower accuracy) -> use it for Hebrew
        cmd = [str(RHUBARB), "-f", "json", "--recognizer", "pocketSphinx" if lang == "en" else "phonetic", "-o", str(dst), str(w)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(w.name, "ok" if r.returncode == 0 else r.stderr[-200:])


def cmd_export_ue(a):
    rows = read_csv(WORK / "lines.csv")
    d = WORK / "ue"
    d.mkdir(exist_ok=True)
    for lang in ("he", "en"):
        write_csv(d / f"ST_Voice_{lang}.csv", [dict(Key=r["id"], SourceString=r["text"]) for r in rows if r["lang"] == lang], ["Key", "SourceString"])
    dt = []
    for r in rows:
        m = out_dir(a.engine) / f"{r['id']}.json"
        if m.exists():
            dt.append(dict(Name=r["id"], Speaker=r["speaker"], Lang=r["lang"], Wav=f"{r['id']}.wav", Seconds=json.loads(m.read_text())["dur"]))
    write_csv(d / "DT_Voice.csv", dt, ["Name", "Speaker", "Lang", "Wav", "Seconds"])
    print(f"wrote {d} ({len(dt)} audio rows)")


def audio_src(dest, code, embed):
    """embed -> one self-contained page (mp3 as data URI) that plays from a phone with no sibling files."""
    if not embed:
        return f"{code}.wav"
    import base64
    mp3 = dest / f"{code}.mp3"
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(dest / f"{code}.wav"), "-b:a", "96k", str(mp3)], check=True)
    uri = "data:audio/mpeg;base64," + base64.b64encode(mp3.read_bytes()).decode()
    mp3.unlink()
    return uri


def blind_mp4(dest, groups):
    """One MP4 for the phone: a black card 'Line N - A/B' over each clip, 0.8 s gaps. Order matches the HTML."""
    clips = []
    for n, (r, items) in enumerate(groups, 1):
        for i, c in enumerate(items):
            out = dest / f"_card{n}{'AB'[i]}.mp4"
            vf = f"drawtext=fontfile=arial.ttf:text='Line {n}  -  {'AB'[i]}':fontcolor=white:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2"
            subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=15", "-i", str(dest / f"{c}.wav"),
                            "-vf", vf, "-af", "apad=pad_dur=0.8,aresample=44100", "-ac", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)], check=True, cwd=FONT_DIR)  # font found via cwd: avoids drive-letter escaping in filter strings
            clips.append(out)
    lst = dest / "_list.txt"
    lst.write_text("".join(f"file '{c.name}'\n" for c in clips), encoding="utf-8")
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-f", "concat", "-i", str(lst), "-c", "copy", str(dest / "blind-test.mp4")], check=True)
    for c in clips + [lst]:
        c.unlink()


def cmd_blind(a):
    """Copy every engine's line to <dest>/<code>.wav under random codes; key kept in KEY-do-not-open.csv; index.html plays variants side by side."""
    import random
    rows = read_csv(WORK / "lines.csv")
    dest = Path(a.dest)
    dest.mkdir(parents=True, exist_ok=True)
    for old in dest.glob("*.wav"):  # a rebuild must not leave stale code-named files
        old.unlink()
    rng = random.Random()
    used, key, groups = set(), [], []
    for r in rows:
        variants = []
        for eng in a.engines:
            w = out_dir(eng) / f"{r['id']}.wav"
            if w.exists():
                variants.append((eng, w))
        if not variants:
            continue
        rng.shuffle(variants)
        items = []
        for eng, w in variants:
            code = "".join(rng.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(6))
            while code in used:
                code = "".join(rng.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(6))
            used.add(code)
            shutil.copy(w, dest / f"{code}.wav")
            key.append(dict(code=code, engine=eng, line_id=r["id"], speaker=r["speaker"], lang=r["lang"]))
            items.append(code)
        groups.append((r, items))
    write_csv(dest / "KEY-do-not-open.csv", key, ["code", "engine", "line_id", "speaker", "lang"])
    voices = load_json("voices.json", {})
    from html import escape
    h = ['<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice blind test</title>',
         '<style>:root{color-scheme:light dark}body{font:16px system-ui;max-width:900px;margin:0 auto;padding:16px}',
         '.l{border:1px solid #8884;border-radius:8px;padding:10px 12px;margin:10px 0}.t{font-size:1.1em;margin:4px 0 8px}',
         '.he{direction:rtl;text-align:right}.v{display:flex;gap:8px;align-items:center;margin:4px 0}.v b{width:1.6em}audio{flex:1;min-width:0}small{opacity:.7}</style></head><body>',
         '<h1>Voice blind test</h1><p>Each line has the same text read by different engines, in random order (A, B, C). Rate by ear; the engine key is in <code>KEY-do-not-open.csv</code>.</p>']
    cur = None
    for r, items in groups:
        if r["speaker"] != cur:
            cur = r["speaker"]
            v = voices.get(cur, {})
            h.append(f'<h2>{escape(v.get("name", cur))}</h2><small>{escape(v.get("desc_en", ""))}</small>')
        h.append(f'<div class="l"><small>{escape(r["emotion"])} &middot; {r["lang"]}</small><div class="t {r["lang"]}" lang="{r["lang"]}">{escape(r["text"])}</div>')
        for i, c in enumerate(items):
            h.append(f'<div class="v"><b>{"ABCD"[i]}</b><audio controls preload="none" src="{audio_src(dest, c, a.embed)}"></audio></div>')
        h.append("</div>")
    h.append("</body></html>")
    (dest / "index.html").write_text("\n".join(h), encoding="utf-8")
    if a.mp4:
        blind_mp4(dest, groups)
    print(f"{len(key)} files, {len(groups)} lines -> {dest}")


def cmd_accent(a):
    """Accent round: spec.json holds accents{name:{strength:phrase}}, characters{speaker:{accent,voice,base,he,en}}. Gemini renders he+en at every strength (same voice, only the style phrase changes);
    --vox adds a VoxCPM2 English clip at the medium strength. Writes WORK/out/accent/<line>_<strength>.wav and accent.csv (WER/CER, LUFS, cost)."""
    spec = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    rows = {r["id"]: r for r in read_csv(WORK / "lines.csv")}
    names, chars = {}, spec["characters"]
    if not a.confirmed:
        sys.exit("gemini is a paid call: pass --confirmed only after the integrator says go")
    jobs = []  # (out dir, tag, row, voices)
    for spk, c in chars.items():
        for lang in ("he", "en"):
            lid = c.get(lang)
            if not lid:
                continue
            for st, phrase in spec["accents"][c["accent"]].items():
                r = dict(rows[lid], direction=phrase.replace("{lang}", {"he": "Hebrew", "en": "English"}[lang]))
                jobs.append(("accent", f"_{st}", r, {spk: {"gemini_voice": c["voice"], "gender": c.get("gender", ""), "short": ""}}))
            if lang == "en" and a.vox:
                r = dict(rows[lid], direction=spec["accents"][c["accent"]]["medium"].replace("{lang}", "English"))
                jobs.append(("accent-voxcpm2", "_medium", r, {spk: {"gender": c.get("gender", ""), "short": c["base"]}}))
    gem, vox = Gemini(), Lazy(VoxCPM2)
    spent, res = 0.0, []
    for od, tag, r, vs in jobs:
        if od == "accent" and spent > a.cap:
            sys.exit(f"cap USD {a.cap} reached at {spent:.4f}; stopping")
        eng = gem if od == "accent" else vox
        out = generate(eng, [r], vs, names, WORK / "out" / od, designing=(od != "accent"), tag=tag)
        meta = json.loads(out[0][1].with_suffix(".json").read_text())
        spent += meta.get("usd", 0) if not out[0][3] else 0
        res.append((od, tag, r, out[0][1], meta))
    vox.obj = None
    free_gpu()
    asr = Asr()
    table = []
    for od, tag, r, w, meta in res:
        wer, cer = asr.errs(w, r["text"], r["lang"])
        table.append(dict(speaker=r["speaker"], lang=r["lang"], line=r["id"], engine="gemini" if od == "accent" else "voxcpm2", strength=tag[1:],
                          voice=chars[r["speaker"]]["voice"] if od == "accent" else "voice design", wer=round(wer, 3), cer=round(cer, 3),
                          flag=("WER>0.25" if wer > 0.25 else "") if r["lang"] == "he" else "en: ivrit model, not scored", lufs=lufs_of(w), dur=meta["dur"], usd=meta.get("usd", 0), wav=str(w)))
        print(table[-1], flush=True)
    write_csv(WORK / "accent.csv", table, list(table[0]))
    print(f"spent this run USD {spent:.4f}; all clips in accent.csv total USD {sum(t['usd'] for t in table):.4f}")


def cmd_accent_pack(a):
    """Phone pack from accent.csv: one MP4 with a title card before each clip + index.html. Titles read 'Name, Hebrew, medium' (', VoxCPM2' for the free engine)."""
    import base64
    from html import escape
    spec = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    dest = Path(a.dest)
    dest.mkdir(parents=True, exist_ok=True)
    order = {s: i for i, s in enumerate(["light", "medium", "strong"])}
    cs = list(spec["characters"])
    rows = sorted(read_csv(WORK / "accent.csv"), key=lambda t: (cs.index(t["speaker"]), t["lang"] != "he", t["engine"] != "gemini", order[t["strength"]]))
    clips, h = [], ['<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accent round</title>',
                    '<style>:root{color-scheme:light dark}body{font:16px system-ui;max-width:900px;margin:0 auto;padding:16px}.v{display:flex;gap:8px;align-items:center;margin:6px 0}.v b{width:11em;font-weight:600}audio{flex:1;min-width:0}small{opacity:.7}</style></head><body>',
                    '<h1>Accent round</h1><p>light = clearly accented; medium = heavy, every word easy; strong = very heavy, edge of clarity. Same voice per character; only the accent changes.</p>']
    cur = None
    for n, t in enumerate(rows, 1):
        c = spec["characters"][t["speaker"]]
        title = f"{c['name']}, {'Hebrew' if t['lang'] == 'he' else 'English'}, {t['strength']}" + (", VoxCPM2" if t["engine"] == "voxcpm2" else "")
        wav = Path(t["wav"])
        loudnorm_file(wav)
        out = dest / f"_c{n}.mp4"
        vf = f"drawtext=fontfile=arial.ttf:text='{title}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=(h-text_h)/2"
        subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=15", "-i", str(wav), "-vf", vf, "-af", "adelay=1000|1000,apad=pad_dur=0.8,aresample=44100", "-ac", "1",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", str(out)], check=True, cwd=FONT_DIR)
        clips.append(out)
        mp3 = dest / "_t.mp3"
        subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "96k", str(mp3)], check=True)
        if c["name"] != cur:
            cur = c["name"]
            h.append(f"<h2>{escape(cur)}</h2><small>{escape(c['accent'])} accent &middot; voice {escape(c['voice'])}</small>")
        h.append(f'<div class="v"><b>{escape(title)}</b><audio controls preload="none" src="data:audio/mpeg;base64,{base64.b64encode(mp3.read_bytes()).decode()}"></audio><small>{"WER " + t["wer"] if t["lang"] == "he" else ""}</small></div>')
        mp3.unlink()
    lst = dest / "_list.txt"
    lst.write_text("".join(f"file '{c.name}'\n" for c in clips), encoding="utf-8")
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-f", "concat", "-i", str(lst), "-c", "copy", str(dest / "accent-round.mp4")], check=True)
    for c in clips + [lst]:
        c.unlink()
    (dest / "index.html").write_text("\n".join(h + ["</body></html>"]), encoding="utf-8")
    print(f"{len(rows)} clips -> {dest}; mp4 LUFS {lufs_of(dest / 'accent-round.mp4')}")


def main():
    p = argparse.ArgumentParser(prog="game-voice")
    s = p.add_subparsers(dest="cmd", required=True)
    x = s.add_parser("import-script"); x.add_argument("script"); x.set_defaults(f=cmd_import_script)
    x = s.add_parser("gen"); x.add_argument("--engine", required=True, choices=ENGINES); x.add_argument("--ids", nargs="*"); x.add_argument("--speaker"); x.add_argument("--lang")
    x.add_argument("--confirmed", action="store_true"); x.add_argument("--plain", action="store_true"); x.add_argument("--plain-only", action="store_true"); x.add_argument("--repoint", action="store_true"); x.set_defaults(f=cmd_gen)
    x = s.add_parser("design"); x.add_argument("--takes", type=int, default=2); x.add_argument("--ids", nargs="*"); x.add_argument("--speaker"); x.add_argument("--lang"); x.set_defaults(f=cmd_design)
    x = s.add_parser("qc"); x.add_argument("--engines", nargs="+", default=["voxcpm2", "moss"]); x.add_argument("--ids", nargs="*"); x.set_defaults(f=cmd_qc)
    x = s.add_parser("visemes"); x.add_argument("--engine", default="voxcpm2"); x.set_defaults(f=cmd_visemes)
    x = s.add_parser("export-ue"); x.add_argument("--engine", default="voxcpm2"); x.set_defaults(f=cmd_export_ue)
    x = s.add_parser("blind"); x.add_argument("--dest", required=True); x.add_argument("--engines", nargs="+", default=["voxcpm2", "moss"]); x.add_argument("--embed", action="store_true"); x.add_argument("--mp4", action="store_true"); x.set_defaults(f=cmd_blind)
    x = s.add_parser("accent"); x.add_argument("spec"); x.add_argument("--confirmed", action="store_true"); x.add_argument("--vox", action="store_true"); x.add_argument("--cap", type=float, default=1.0); x.set_defaults(f=cmd_accent)
    x = s.add_parser("accent-pack"); x.add_argument("spec"); x.add_argument("--dest", required=True); x.set_defaults(f=cmd_accent_pack)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
