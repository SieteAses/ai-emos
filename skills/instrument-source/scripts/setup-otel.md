# Exportar OpenTelemetry-GenAI a un archivo OTLP-JSON

`ai-emos` ingiere spans OTel-GenAI / OpenInference con el adaptador
`otel-genai`. Cualquier sistema instrumentado con OTel puede hacerse observable sin
SDK propio. La forma más simple para visualizar localmente es **exportar a un
archivo OTLP-JSON** y pasárselo al CLI.

## Atributos que el adaptador entiende

Maneja ambas convenciones (usa la que tu instrumentación emita):

| concepto | OTel-GenAI | OpenInference |
|---|---|---|
| tipo de span | `gen_ai.operation.name` (chat/execute_tool/invoke_agent) | `openinference.span.kind` (LLM/TOOL/AGENT/CHAIN/RETRIEVER) |
| modelo | `gen_ai.request.model` | `llm.model_name` |
| tokens in/out | `gen_ai.usage.input_tokens` / `output_tokens` | `llm.token_count.prompt` / `completion` |
| nombre de tool | `gen_ai.tool.name` | `tool.name` |
| nombre de agente | `gen_ai.agent.name` | — |
| I/O | `gen_ai.prompt` / `gen_ai.completion` | `input.value` / `output.value` |

La anidación de sub-agentes se reconstruye con `parentSpanId` (un span hijo cuelga
del span `AGENT` ancestro más cercano). Una sesión = un `traceId`.

## Opción A — Collector de OpenTelemetry a archivo

Configura el OpenTelemetry Collector con un exporter `file`:

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http: {}
      grpc: {}
exporters:
  file:
    path: /tmp/spans.otlp.json   # OTLP-JSON, una entrada por export
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file]
```

Apunta tu app al collector:
```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

## Opción B — Exporter de archivo directo (sin collector)

Muchos SDKs de OTel permiten un exporter a stdout/archivo en formato OTLP-JSON.
Vuelca los spans a un `.json` con la forma `{ "resourceSpans": [ ... ] }`.

## Visualizar

```sh
node <repo>/skills/visualize-session/scripts/cli.mjs \
  --adapter otel-genai --session /tmp/spans.otlp.json \
  --html ./otel-timeline.html

# si el archivo trae varios traces, lístalos y elige uno:
node <repo>/skills/visualize-session/scripts/cli.mjs --adapter otel-genai --file /tmp/spans.otlp.json --list
```

> Nota: muchos exports OTel no incluyen el texto completo del prompt/respuesta ni el
> desglose de caché. El visor degrada con gracia: muestra "n/d" donde la fuente no
> reporta, y los tokens al nivel que el span sí atribuye.
