"""
Whisper 常驻转写服务 — 模型只加载一次，通过 stdin/stdout 与 Node.js 通信。
协议：stdin 每行一个 WAV 路径，stdout 每行一个 JSON {"text": "..."}
启动成功后先输出 {"status": "ready"}
"""
import os, sys, json

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
PROMPT = "以下是普通话的句子，请使用简体中文。"


def main():
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        wav_path = line.strip()
        if not wav_path:
            continue
        try:
            segments, _ = model.transcribe(
                wav_path, language="zh", initial_prompt=PROMPT
            )
            text = "".join(seg.text for seg in segments).strip()
            result = text if text else "（未识别到清晰语音）"
        except Exception:
            result = "（转写失败）"
        sys.stdout.write(json.dumps({"text": result}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
