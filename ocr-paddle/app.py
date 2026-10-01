"""
Layanan OCR PaddleOCR untuk eclaim_api.

Dipanggil dari src/services/ocrService.js (OCR_ENGINE=paddle) dengan gambar
PNG halaman PDF yang sudah dirender mupdf. Mengembalikan teks per baris dalam
urutan baca, rata-rata keyakinan (0-100, skala yang sama dengan Tesseract),
dan kotak tiap baris. Tidak ada data yang disimpan.
"""
import os
import threading

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from paddleocr import PaddleOCR

DET_MODEL = os.environ.get("PADDLE_OCR_DET_MODEL", "PP-OCRv5_mobile_det")
REC_MODEL = os.environ.get("PADDLE_OCR_REC_MODEL", "latin_PP-OCRv5_mobile_rec")

app = FastAPI()
# Model mobile dipilih dari uji berkas EIFFELIN (6 halaman, CPU arm64):
# keyakinan rata-rata ~97,5% dengan semua nilai vital/diagnosis/tindakan
# terbaca benar, 2-3x lebih cepat dari PP-OCRv6_medium (98,5%, 21-32
# dtk/halaman). Model pengenalan latin mencakup bahasa Indonesia.
_ocr = PaddleOCR(
    text_detection_model_name=DET_MODEL,
    text_recognition_model_name=REC_MODEL,
    text_recognition_batch_size=16,
    cpu_threads=int(os.environ.get("PADDLE_OCR_CPU_THREADS", os.cpu_count() or 4)),
    # Halaman berasal dari render PDF (tegak, tidak melengkung) -- model
    # orientasi/unwarping hanya menambah waktu tanpa manfaat.
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
)
# Satu instance model dipakai bersama; inferensi Paddle tidak dijamin aman
# untuk dipanggil paralel dari beberapa thread.
_lock = threading.Lock()


def _susun_baris(teks, skor, kotak):
    """Gabungkan potongan teks yang sebaris (y bertumpuk) dari kiri ke kanan."""
    item = []
    for t, s, b in zip(teks, skor, kotak):
        x1, y1, x2, y2 = [float(v) for v in b]
        item.append({"text": t, "confidence": float(s), "bbox": [x1, y1, x2, y2]})
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
    return {"status": "ok", "det": DET_MODEL, "rec": REC_MODEL}


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
            return _ocr.predict(img)

    # Inferensi memblokir; dijalankan di thread supaya /health tetap responsif.
    res = await run_in_threadpool(_jalankan)
    r = res[0] if res else {}
    teks = list(r.get("rec_texts", []) or [])
    skor = list(r.get("rec_scores", []) or [])
    kotak = r.get("rec_boxes")
    kotak = kotak.tolist() if hasattr(kotak, "tolist") else list(kotak or [])

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
