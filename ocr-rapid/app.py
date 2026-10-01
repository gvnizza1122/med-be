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


@app.post("/ocr")
async def ocr(request: Request):
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="body gambar kosong")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="gambar tidak dapat dibaca")

    def _jalankan():
        with _lock:
            return _ocr(img)

    # Inferensi memblokir; dijalankan di thread supaya /health tetap responsif.
    r = await run_in_threadpool(_jalankan)
    teks = list(r.txts or [])
    skor = [float(s) for s in (r.scores or [])]
    kotak = r.boxes.tolist() if r.boxes is not None else []

    baris = _susun_baris(teks, skor, kotak)
    keyakinan = (sum(skor) / len(skor) * 100) if skor else 0.0
    return {
        "text": "\n".join(b["text"] for b in baris),
        "confidence": round(keyakinan, 2),
        "lines": [
            {"text": b["text"], "confidence": round(b["confidence"] * 100, 2), "bbox": b["bbox"]}
            for b in baris
        ],
    }
