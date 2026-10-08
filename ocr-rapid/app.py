"""
Layanan OCR RapidOCR untuk eclaim_api (pengganti ocr-paddle, yang tetap
disimpan sebagai cadangan).

Model PP-OCRv5 yang sama dengan PaddleOCR, tetapi dijalankan dengan ONNX
Runtime. Uji berkas EIFFELIN (6 halaman, CPU arm64): 1,4-2,2 dtk/halaman,
keyakinan 98,4-99,2%, tabel tanda vital & triase terbaca utuh -- versus
10-16 dtk/halaman dengan runtime Paddle (ocr-paddle).

API sama persis dengan ocr-paddle/app.py supaya src/services/ocrService.js
tidak perlu diubah: POST /ocr (body = PNG) -> {text, confidence 0-100, lines}.
Tidak ada data yang disimpan.
"""
import threading

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

PARAMS = {
    "Det.ocr_version": OCRVersion.PPOCRV5,
    "Det.model_type": ModelType.MOBILE,
    "Rec.ocr_version": OCRVersion.PPOCRV5,
    "Rec.model_type": ModelType.MOBILE,
    # Model latin mencakup bahasa Indonesia dan istilah medis Inggris.
    "Rec.lang_type": LangRec.LATIN,
}

app = FastAPI()
_ocr = RapidOCR(params=PARAMS)
_lock = threading.Lock()


def _susun_baris(teks, skor, kotak):
    """Gabungkan potongan teks yang sebaris (y bertumpuk) dari kiri ke kanan."""
    item = []
    for t, s, b in zip(teks, skor, kotak):
        xs = [float(p[0]) for p in b]
        ys = [float(p[1]) for p in b]
        item.append({"text": t, "confidence": float(s), "bbox": [min(xs), min(ys), max(xs), max(ys)]})
    item.sort(key=lambda i: (i["bbox"][1] + i["bbox"][3]) / 2)

    baris = []
    for i in item:
        tengah = (i["bbox"][1] + i["bbox"][3]) / 2
        tinggi = i["bbox"][3] - i["bbox"][1]
        if baris:
            akhir = baris[-1]
            if abs(tengah - akhir["tengah"]) < max(tinggi, akhir["tinggi"]) * 0.5:
                akhir["isi"].append(i)
                continue
        baris.append({"tengah": tengah, "tinggi": tinggi, "isi": [i]})

    hasil = []
    for b in baris:
        isi = sorted(b["isi"], key=lambda i: i["bbox"][0])
        hasil.append({
            "text": " ".join(i["text"] for i in isi),
            "confidence": sum(i["confidence"] for i in isi) / len(isi),
            "bbox": [
                min(i["bbox"][0] for i in isi), min(i["bbox"][1] for i in isi),
                max(i["bbox"][2] for i in isi), max(i["bbox"][3] for i in isi),
            ],
        })
    return hasil


@app.get("/health")
def health():
    return {"status": "ok", "engine": "rapidocr-onnx", "model": "PP-OCRv5 mobile det + latin rec"}


# --- OCR adaptif untuk hasil scan buruk -------------------------------------
# Halaman dibaca apa adanya dulu. Bila hasilnya lemah (keyakinan rendah atau
# teks sangat sedikit), dicoba ulang dengan perbaikan gambar dan rotasi, lalu
# dipilih hasil terbaik (skor = keyakinan x jumlah karakter terbaca). Halaman
# yang sudah bagus tidak diproses ulang, jadi biaya tambahan hanya untuk scan
# buruk. Contoh pemicu: rekaman EKG terputar 90 derajat (PASIEN CONTOH A
# 0000R0000126V000002 hal. 8-9), fotokopi pudar, scan miring.
AMBANG_KEYAKINAN = float(__import__("os").environ.get("OCR_AMBANG_KEYAKINAN", "88"))
AMBANG_KARAKTER = int(__import__("os").environ.get("OCR_AMBANG_KARAKTER", "80"))


def _abu(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img


def _kontras(img):
    g = _abu(img)
    g = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(g)
    return cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)


def _tajam(img):
    g = _abu(img)
    g = cv2.fastNlMeansDenoising(g, None, h=12, templateWindowSize=7, searchWindowSize=21)
    blur = cv2.GaussianBlur(g, (0, 0), 2.0)
    g = cv2.addWeighted(g, 1.6, blur, -0.6, 0)
    return cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)


def _biner(img):
    g = cv2.medianBlur(_abu(img), 3)
    b = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15)
    return cv2.cvtColor(b, cv2.COLOR_GRAY2BGR)


def _luruskan(img):
    """Koreksi kemiringan kecil (<=15 derajat) dari sebaran piksel teks."""
    g = _abu(img)
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    titik = np.column_stack(np.where(b > 0))
    if len(titik) < 500:
        return None
    sudut = cv2.minAreaRect(titik[:, ::-1].astype(np.float32))[-1]
    if sudut > 45:
        sudut -= 90
    if abs(sudut) < 0.5 or abs(sudut) > 15:
        return None
    h, w = g.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), sudut, 1.0)
    return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


ROTASI = {
    "rotasi_90": cv2.ROTATE_90_CLOCKWISE,
    "rotasi_270": cv2.ROTATE_90_COUNTERCLOCKWISE,
    "rotasi_180": cv2.ROTATE_180,
}


def _baca(img):
    with _lock:
        r = _ocr(img)
    teks = list(r.txts or [])
    skor = [float(s) for s in (r.scores or [])]
    kotak = r.boxes.tolist() if r.boxes is not None else []
    baris = _susun_baris(teks, skor, kotak)
    keyakinan = (sum(skor) / len(skor) * 100) if skor else 0.0
    karakter = sum(len(t) for t in teks)
    return {"baris": baris, "keyakinan": keyakinan, "karakter": karakter,
            "skor": keyakinan * min(karakter, 4000)}


def _lemah(h):
    return h["keyakinan"] < AMBANG_KEYAKINAN or h["karakter"] < AMBANG_KARAKTER


# Batas waktu tambahan per halaman untuk perbaikan gambar. Layanan memproses
# satu halaman sekali jalan (_lock), jadi tanpa batas ini beberapa berkas
# sekaligus membuat antrean timeout dan halaman jatuh ke Tesseract
# (unggahan 06/10: SLAMET FAHRODIN & MUHAMMAD ARSYA).
BATAS_TAMBAHAN_DETIK = float(__import__("os").environ.get("OCR_BATAS_TAMBAHAN_DETIK", "12"))


def _gabung(terbaik, tambahan):
    ada = {"".join(b["text"].lower().split()) for b in terbaik["baris"]}
    baru = [b for b in tambahan["baris"] if b["confidence"] >= 0.6
            and "".join(b["text"].lower().split()) not in ada]
    if not baru:
        return terbaik
    semua = terbaik["baris"] + baru
    skor = [b["confidence"] for b in semua]
    return {
        "baris": semua,
        "keyakinan": sum(skor) / len(skor) * 100,
        "karakter": sum(len(b["text"]) for b in semua),
        "skor": terbaik["skor"] + tambahan["skor"],
        "varian": terbaik["varian"] + "+" + tambahan["varian"],
    }


def _ocr_adaptif(img):
    import time
    mulai = time.monotonic()
    habis = lambda: time.monotonic() - mulai > BATAS_TAMBAHAN_DETIK
    terbaik = dict(_baca(img), varian="asli")
    if not _lemah(terbaik):
        return terbaik
    mulai = time.monotonic()  # anggaran dihitung sesudah bacaan pertama
    # 1. Penajaman (uji: satu-satunya perbaikan yang menaikkan hasil; kontras &
    #    binarisasi justru menurunkan, jadi tidak dicoba).
    try:
        h = dict(_baca(_tajam(img)), varian="tajam")
        if h["skor"] > terbaik["skor"]:
            terbaik = h
    except Exception:
        pass
    if not _lemah(terbaik) or habis():
        return terbaik
    # 2. Halaman terputar / teks dua arah (rekaman EKG): rotasi terbaik
    #    digabung dengan hasil sejauh ini.
    rotasi = None
    for nama, kode in ROTASI.items():
        if habis():
            break
        h = dict(_baca(cv2.rotate(img, kode)), varian=nama)
        if rotasi is None or h["skor"] > rotasi["skor"]:
            rotasi = h
    if rotasi and rotasi["karakter"] >= 40 and rotasi["keyakinan"] >= 60:
        if rotasi["skor"] > terbaik["skor"] * 1.5:
            terbaik = _gabung(rotasi, terbaik)
        else:
            terbaik = _gabung(terbaik, rotasi)
    if not _lemah(terbaik) or habis():
        return terbaik
    # 3. Kemiringan kecil.
    try:
        lurus = _luruskan(img)
        if lurus is not None:
            h = dict(_baca(lurus), varian="lurus")
            if h["skor"] > terbaik["skor"]:
                terbaik = h
    except Exception:
        pass
    return terbaik


# --- Pemulihan baris yang tidak terdeteksi ---------------------------------
# Detektor kadang melewatkan satu baris utuh di tengah paragraf yang rapat,
# bahkan pada halaman bersih ber-keyakinan tinggi -- laporan operasi KASUS ACUAN STT
# (0000R0000126V000001 hal. 14) kehilangan "sampai ke lapisan otot pectoralis
# mayor - Otot pectoralis mayor split kanan kiri, mencapai massa tumor di",
# satu-satunya bukti tumor di bawah fascia. Baris dalam satu paragraf normalnya
# rapat/bertumpuk; celah tegak >= 0,3 x tinggi baris menandakan baris yang
# hilang. Area celah dipotong dan dibaca ulang; hanya teks yang terbaca jelas
# dan belum ada yang disisipkan.
import os as _os
import re as _re
MAKS_CELAH = int(_os.environ.get("OCR_MAKS_CELAH", "12"))


def _isi_celah(img, h):
    baris = sorted(h["baris"], key=lambda b: b["bbox"][1])
    if len(baris) < 2:
        return h
    tinggi = sorted(b["bbox"][3] - b["bbox"][1] for b in baris)
    t_med = max(1.0, float(tinggi[len(tinggi) // 2]))
    H, W = img.shape[:2]
    tambahan = []
    dicek = 0
    teks_ada = lambda: ["".join(x["text"].lower().split()) for x in baris + tambahan]
    for a, b in zip(baris, baris[1:]):
        if dicek >= MAKS_CELAH:
            break
        # Satu paragraf: tepi kiri berdekatan dan keduanya baris panjang (bukan label/sel tabel).
        if abs(a["bbox"][0] - b["bbox"][0]) > max(60.0, 1.5 * t_med):
            continue
        if min(a["bbox"][2] - a["bbox"][0], b["bbox"][2] - b["bbox"][0]) < 8 * t_med:
            continue
        celah = b["bbox"][1] - a["bbox"][3]
        if not (0.3 * t_med <= celah <= 1.8 * t_med):
            continue
        # Kalimat bersambung melintasi celah: baris atas belum selesai atau
        # baris bawah mulai huruf kecil. Jarak antarbaris tabel/formulir tidak
        # memenuhi ini, sehingga tidak dibaca ulang percuma.
        ta, tb = a["text"].rstrip(), b["text"].lstrip(" -")
        bersambung = (tb[:1].islower() or ta.endswith((",", "-", "/"))
                      or _re.search(r"\b(?:dan|dengan|yang|di|ke|sampai|atau|serta)$", ta, _re.I) is not None)
        if not bersambung:
            continue
        dicek += 1
        y0 = max(0, int(a["bbox"][3] - 0.35 * t_med))
        y1 = min(H, int(b["bbox"][1] + 0.35 * t_med))
        x0 = max(0, int(min(a["bbox"][0], b["bbox"][0]) - t_med))
        x1 = min(W, int(max(a["bbox"][2], b["bbox"][2]) + t_med))
        if y1 - y0 < 8 or x1 - x0 < 8:
            continue
        try:
            r = _baca(img[y0:y1, x0:x1])
        except Exception:
            continue
        for c in r["baris"]:
            teks = c["text"].strip()
            if c["confidence"] < 0.85 or len(teks) < 8 or len(_re.findall(r"[A-Za-z]{2,}", teks)) < 2:
                continue
            kunci = "".join(teks.lower().split())
            if any(kunci in t for t in teks_ada()):
                continue
            bx = c["bbox"]
            tambahan.append({"text": teks, "confidence": c["confidence"],
                             "bbox": [bx[0] + x0, bx[1] + y0, bx[2] + x0, bx[3] + y0]})
    if not tambahan:
        return h
    semua = sorted(baris + tambahan, key=lambda b: (b["bbox"][1] + b["bbox"][3]) / 2)
    skor = [b["confidence"] for b in semua]
    return {**h, "baris": semua, "keyakinan": sum(skor) / len(skor) * 100,
            "karakter": sum(len(b["text"]) for b in semua),
            "varian": h.get("varian", "asli") + "+celah", "baris_dipulihkan": len(tambahan)}


def _ocr_lengkap(img):
    h = _ocr_adaptif(img)
    try:
        return _isi_celah(img, h)
    except Exception:
        return h


@app.post("/ocr")
async def ocr(request: Request):
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="body gambar kosong")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="gambar tidak dapat dibaca")

    # Inferensi memblokir; dijalankan di thread supaya /health tetap responsif.
    h = await run_in_threadpool(_ocr_lengkap, img)
    return {
        "text": "\n".join(b["text"] for b in h["baris"]),
        "confidence": round(h["keyakinan"], 2),
        "varian": h["varian"],
        "baris_dipulihkan": h.get("baris_dipulihkan", 0),
        "lines": [
            {"text": b["text"], "confidence": round(b["confidence"] * 100, 2), "bbox": b["bbox"]}
            for b in h["baris"]
        ],
    }
