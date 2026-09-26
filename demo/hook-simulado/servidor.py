"""
Laboratório local de browser hijacking (simulação inofensiva do BeEF).

  - http://localhost:8000/   página "vítima" (carrega o hook de outro site)
  - http://127.0.0.1:8001/   servidor "atacante": entrega hook.js e responde /poll

localhost e 127.0.0.1 são sites diferentes, então o hook é de terceira parte.
Nada sai da máquina: o "atacante" é este próprio script.

Uso: python demo/hook-simulado/servidor.py
"""
import http.server
import os
import threading

HERE = os.path.dirname(os.path.abspath(__file__))


class Victim(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(HERE, "vitima"), **kwargs)

    def log_message(self, *args):
        pass


class Attacker(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/hook.js"):
            body = open(os.path.join(HERE, "atacante", "hook.js"), "rb").read()
            ctype = "application/javascript"
        else:
            # /poll e /k: o "servidor de comando" não manda comandos, só confirma.
            body, ctype = b"{}", "application/json"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("[atacante]", self.path)


if __name__ == "__main__":
    threading.Thread(target=http.server.ThreadingHTTPServer(("127.0.0.1", 8001), Attacker).serve_forever, daemon=True).start()
    print("vítima:   http://localhost:8000/\natacante: http://127.0.0.1:8001/hook.js")
    http.server.ThreadingHTTPServer(("localhost", 8000), Victim).serve_forever()
