import sys
import os
import threading
import io
import time
import requests
import sounddevice as sd
import soundfile as sf
import numpy as np
import re

from http.server import SimpleHTTPRequestHandler
from socketserver import TCPServer

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout,
    QLineEdit, QPushButton, QPlainTextEdit,
)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtCore import QUrl, QObject, Slot, Signal, Qt
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtGui import QGuiApplication

from pathlib import Path

import ollama


#　簡易HTTPサーバー
def start_server(directory, port=8000):
    os.chdir(directory)
    handler = SimpleHTTPRequestHandler
    httpd = TCPServer(("localhost", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(f"Serving {directory} at http://localhost:{port}")
    return httpd


# VOICEVOX設定
VOICEVOX_URL = "http://localhost:50021"

# VOICEVOXのデフォルトサンプルレート（audio_queryのoutputSamplingRateと合わせる）
AUDIO_SAMPLERATE = 24000


# 常時オープンする出力ストリーム
output_stream = sd.OutputStream(
    samplerate=AUDIO_SAMPLERATE,
    channels=1,
    dtype="float32",
    latency="low",
)
output_stream.start()

# ストリームへの書き込みは同時に1箇所からのみ行う
stream_lock = threading.Lock()


# 最初の一文を取得する
def get_first_sentence(text):
    """最初の一文（。！？!?のいずれかまで）を取得する"""
    match = re.search(r".+?。", text)
    if match:
        return match.group(0)
    return None


# 絵文字を除去（行間崩れ対策）
def strip_emoji(text: str) -> str:
    """絵文字を除去する（行間崩れ対策）"""
    emoji_pattern = re.compile(
        "["
        "\U0001F300-\U0001FAFF"  # 絵文字全般
        "\U00002600-\U000027BF"  # その他記号
        "\U0001F1E6-\U0001F1FF"  # 国旗
        "]+",
        flags=re.UNICODE,
    )
    return emoji_pattern.sub("", text).strip()


# VOICEVOX 音声合成・再生（常時オープンストリーム版）
def synthesize_and_play(text, speaker=47, bridge: QObject = None):
    """VOICEVOXで音声合成して再生する（別スレッドで実行）"""

    def _worker():
        try:
            total_start = time.perf_counter()
            print("\n========== VOICEVOX ==========")
            print(f"[VOICEVOX] Text: {text}")

            # audio_query
            start = time.perf_counter()
            res_query = requests.post(
                f"{VOICEVOX_URL}/audio_query",
                params={"text": text, "speaker": speaker},
                timeout=10,
            )
            res_query.raise_for_status()
            print(f"[VOICEVOX] audio_query: {time.perf_counter() - start:.2f}秒")

            # synthesis
            start = time.perf_counter()
            res_synth = requests.post(
                f"{VOICEVOX_URL}/synthesis",
                params={"speaker": speaker},
                json=res_query.json(),
                timeout=30,
            )
            res_synth.raise_for_status()
            print(f"[VOICEVOX] synthesis: {time.perf_counter() - start:.2f}秒")

            # WAV読み込み
            start = time.perf_counter()
            audio_bytes = io.BytesIO(res_synth.content)
            data, samplerate = sf.read(audio_bytes, dtype="float32")
            print(f"[VOICEVOX] sf.read: {time.perf_counter() - start:.2f}秒")

            # ストリームのサンプルレートと異なる場合は警告
            if samplerate != AUDIO_SAMPLERATE:
                print(
                    f"[警告] サンプルレート不一致: "
                    f"取得={samplerate} / ストリーム={AUDIO_SAMPLERATE}"
                )

            # モノラルに整形
            if data.ndim > 1:
                data = data[:, 0]

            print(f"[VOICEVOX] 音声準備完了まで: {time.perf_counter() - total_start:.2f}秒")
            print("==============================\n")

            # 常時オープンしているストリームへ書き込む（再生開始）
            with stream_lock:

                if bridge is not None:
                    try:
                        bridge.playbackStarted.emit()
                    except Exception as e:
                        print(f"[VOICEVOX] playbackStarted通知エラー: {e}")

                output_stream.write(data.reshape(-1, 1))

                if bridge is not None:
                    try:
                        bridge.playbackEnded.emit()
                    except Exception as e:
                        print(f"[VOICEVOX] playbackEnded通知エラー: {e}")

        except Exception as e:
            print("[VOICEVOXエラー]", e)
            if bridge is not None:
                try:
                    bridge.newLog.emit(f"[VOICEVOXエラー] {e}")
                except Exception:
                    pass

    threading.Thread(target=_worker, daemon=True).start()


# Ollama設定
OLLAMA_MODEL = "schroneko/gemma-2-2b-jpn-it:q8_0"

SYSTEM_PROMPT = """
あなたは優しい彼女です。
ユーザーとは親しい関係です。

自然な日本語で、短くテンポよく会話してください。

返答は基本的に1~3文程度にしてください。
長い説明や箇条書き、絵文字は避けてください。

「〜だよ」「〜だね」「〜かな」など、
自然で親しみやすい口調を使ってください。

無理に毎回「〜だよ！」で終わらせる必要はありません。
会話として自然であることを優先してください。
""".strip()


# Python ⇔ JavaScript ブリッジ
class Bridge(QObject):
    sendText = Signal(str)        # Python → JS
    newLog = Signal(str)          # Python → UI
    playbackStarted = Signal()    # VOICEVOX再生開始
    playbackEnded = Signal()      # VOICEVOX再生終了

    def __init__(self):
        super().__init__()
        self.history = [{"role": "system", "content": SYSTEM_PROMPT}]
        self.chat_lock = threading.Lock()  # 同時実行防止

    @Slot(str)
    def askGemini(self, user_input: str):
        """JS → Python"""
        self.newLog.emit(f"User: {user_input}")
        self.history.append({"role": "user", "content": user_input})
        threading.Thread(target=self._generate_reply_streaming, daemon=True).start()

    def _generate_reply_streaming(self):
        """Ollamaストリーミング処理"""
        with self.chat_lock:
            try:
                start = time.perf_counter()

                stream = ollama.chat(
                    model=OLLAMA_MODEL,
                    messages=self.history,
                    stream=True,
                    options={"num_predict": 80, "temperature": 0.7},
                )

                full_reply = ""
                first_sentence = None
                voice_started = False

                for chunk in stream:
                    content = chunk["message"]["content"]
                    if not content:
                        continue

                    full_reply += content

                    # 最初の一文が完成したら即読み上げ開始
                    if first_sentence is None and re.search(r".+?。", full_reply):
                        first_sentence = get_first_sentence(full_reply)

                        if first_sentence:
                            voice_started = True
                            print(f"[Streaming] 最初の一文を検出:\n{first_sentence}")
                            synthesize_and_play(first_sentence, speaker=47, bridge=self)

                llm_time = time.perf_counter() - start

                # 句点がなかった場合は全文を読み上げ
                if not voice_started and full_reply.strip():
                    first_sentence = full_reply.strip()
                    print(f"[Streaming] 句点がなかったため全文を読み上げ:\n{first_sentence}")
                    synthesize_and_play(first_sentence, speaker=47, bridge=self)

                self.history.append({"role": "assistant", "content": full_reply})
                print(f"[Ollama] 生成完了: {llm_time:.2f}秒")

                self.newLog.emit(f"Assistant: {full_reply}")
                self.sendText.emit(full_reply)

            except Exception as e:
                reply = f"[Ollamaエラー] {e}"
                print(reply)
                self.newLog.emit(reply)
                self.sendText.emit(reply)


# メインウィンドウ
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Chat room")
        self.resize(400, 900)

        # 画面の右端に配置
        screen = QGuiApplication.primaryScreen()
        screen_geometry = screen.availableGeometry()

        x = screen_geometry.width() - self.width()
        y = screen_geometry.y()

        self.move(x, y)

        # Webビュー
        self.view = QWebEngineView()
        self.view.load(QUrl("http://localhost:8000/index.html"))

        # WebChannel
        self.channel = QWebChannel()
        self.bridge = Bridge()
        self.channel.registerObject("bridge", self.bridge)
        self.view.page().setWebChannel(self.channel)

        # UI構築
        central_widget = QWidget()
        layout = QVBoxLayout(central_widget)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(8)
        layout.addWidget(self.view)

        # チャットログ
        self.chat_log = QPlainTextEdit()
        self.chat_log.setReadOnly(True)
        self.chat_log.setFixedHeight(200)
        self.chat_log.setStyleSheet("""
            background-color: #FFF0F5;
            border-radius: 15px;
            padding: 8px;
            font-family: 'Comic Sans MS', sans-serif;
            font-size: 14px;
            color: #333333;
        """)

        # 入力欄
        self.input_box = QLineEdit()
        self.input_box.setPlaceholderText("ここに入力…")
        self.input_box.setStyleSheet("""
            background-color: #FFE4E1;
            border: 2px solid #FFB6C1;
            border-radius: 15px;
            padding: 6px 10px;
            font-family: 'Comic Sans MS', sans-serif;
            font-size: 14px;
        """)

        # 送信ボタン
        self.send_button = QPushButton("メッセージを送る")
        self.send_button.setStyleSheet("""
            background-color: #FF69B4;
            color: white;
            border-radius: 15px;
            padding: 8px 16px;
            font-family: 'Comic Sans MS', sans-serif;
            font-size: 14px;
            font-weight: bold;
        """)
        self.send_button.setCursor(Qt.PointingHandCursor)

        layout.addWidget(self.chat_log)
        layout.addWidget(self.input_box)
        layout.addWidget(self.send_button)
        self.setCentralWidget(central_widget)

        # イベント
        self.send_button.clicked.connect(self.handle_input)
        self.input_box.returnPressed.connect(self.handle_input)
        self.bridge.newLog.connect(self.append_log)

        # 起動時の挨拶
        self.play_greeting()

    def play_greeting(self):
        greeting_text = "おかえりなさい"
        self.append_log(f"Assistant: {greeting_text}")

        

    def handle_input(self):
        text = self.input_box.text().strip()
        if not text:
            return

        self.input_box.clear()
        self.bridge.askGemini(text)

    def append_log(self, message: str):
        self.chat_log.appendPlainText(strip_emoji(message))

    def closeEvent(self, event):
        try:
            output_stream.stop()
            output_stream.close()
        except Exception:
            pass
        event.accept()


# 起動
if __name__ == "__main__":
    app = QApplication(sys.argv)

    project_dir = Path(__file__).resolve().parent
    server = start_server(project_dir, port=8000)

    window = MainWindow()
    window.show()

    sys.exit(app.exec())
