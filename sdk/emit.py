"""
sdk/emit.py — mini-SDK para que cualquier agente Python emita una traza
observable por ai-emos (formato NDJSON), sin OTel ni dependencias.

    from emit import Tracer
    t = Tracer("./traces/run.ndjson", title="mi corrida", source="mi-agente")
    t.message("user", "¿qué hago?")
    a = t.agent("investigador", id="a1")
    a.tool("search", input="leaflet", output="...", tokens={"input": 10, "output": 5})
    t.decision("¿seguir?", options=["sí", "no"], chosen=["sí"])
    t.close()
"""

import json
import os
import time
from datetime import datetime, timezone


def _now():
    return datetime.now(timezone.utc).isoformat()


class _Agent:
    def __init__(self, tracer, agent_id):
        self._t = tracer
        self._pid = agent_id

    def message(self, role, text, **extra):
        self._t._write({"kind": "message", "role": role, "text": text, "parentId": self._pid, **extra})
        return self

    def thinking(self, text, **extra):
        self._t._write({"kind": "thinking", "role": "assistant", "text": text, "parentId": self._pid, **extra})
        return self

    def tool(self, name, **opts):
        opts["parentId"] = self._pid
        self._t.tool(name, **opts)
        return self

    def llm(self, label, **opts):
        self._t._write({"kind": "llm_call", "label": label, "parentId": self._pid, **opts})
        return self


class Tracer:
    def __init__(self, file, sessionId=None, title=None, source="ndjson", models=None, cwd=None):
        os.makedirs(os.path.dirname(file) or ".", exist_ok=True)
        self._f = open(file, "w", encoding="utf-8")
        self._write({
            "kind": "session",
            "sessionId": sessionId or os.path.basename(file).replace(".ndjson", ""),
            "title": title,
            "source": source,
            "cwd": cwd or os.getcwd(),
            "models": models or [],
        })

    def _write(self, obj):
        if obj.get("kind") != "session" and "ts" not in obj:
            obj["ts"] = _now()
        self._f.write(json.dumps(obj, ensure_ascii=False) + "\n")

    def message(self, role, text, **extra):
        self._write({"kind": "message", "role": role, "text": text, **extra})
        return self

    def thinking(self, text, **extra):
        self._write({"kind": "thinking", "role": "assistant", "text": text, **extra})
        return self

    def llm(self, label, tokens=None, input=None, output=None, durationMs=None, model=None):
        self._write({"kind": "llm_call", "label": label, "tokens": tokens, "input": input,
                     "output": output, "durationMs": durationMs, "model": model})
        return self

    def tool(self, name, input=None, output=None, isError=False, tokens=None, durationMs=None, parentId=None):
        self._write({"kind": "tool_call", "label": f"tool:{name}", "input": input, "output": output,
                     "isError": isError, "tokens": tokens, "durationMs": durationMs, "parentId": parentId})
        return self

    def skill(self, name, **extra):
        self._write({"kind": "skill", "label": f"skill:{name}", **extra})
        return self

    def decision(self, prompt, options=None, chosen=None, decidedBy="human", interrupted=False):
        self._write({"kind": "decision", "label": "decisión humana",
                     "decision": {"prompt": prompt, "options": options, "chosen": chosen,
                                  "decidedBy": decidedBy, "interrupted": interrupted}})
        return self

    def event(self, label, **extra):
        self._write({"kind": "event", "label": label, **extra})
        return self

    def agent(self, name, id=None, tokens=None, durationMs=None, stats=None):
        agent_id = id or f"a{int(time.time() * 1000)}_{name}"
        self._write({"kind": "agent", "label": f"agente:{name}", "agentName": name,
                     "agentId": agent_id, "tokens": tokens, "durationMs": durationMs, "stats": stats})
        return _Agent(self, agent_id)

    def close(self):
        try:
            self._f.close()
        except Exception:
            pass
